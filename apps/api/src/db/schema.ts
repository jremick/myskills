import { sql } from "drizzle-orm";
import type { SkillReleaseChangeKind, SkillReleaseCompatibility, SkillUpgradePolicyV1, TargetSkillOperationResult } from "@myskills-app/core";
import {
  check,
  foreignKey,
  bigint,
  integer,
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userStatus = pgEnum("user_status", ["pending", "active", "disabled", "deleted"]);
export const roleName = pgEnum("role_name", ["owner", "admin", "maintainer", "author", "user"]);
export const registrationMode = pgEnum("registration_mode", ["closed", "request", "open"]);
export const providerType = pgEnum("provider_type", ["oidc", "saml", "cloudflare_access", "github", "google"]);
export const skillLifecycleStatus = pgEnum("skill_lifecycle_status", ["draft", "private", "submitted", "review", "approved", "deprecated", "unpublished", "revoked", "archived"]);
export const visibilityScope = pgEnum("visibility_scope", ["public", "authenticated", "organization", "team", "private", "explicit-users"]);
export const reviewStatus = pgEnum("review_status", ["unreviewed", "changes-requested", "approved", "rejected"]);
export const securityStatus = pgEnum("security_status", ["not-run", "passed", "warning", "failed"]);
export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "failed"]);
export const mfaFactorType = pgEnum("mfa_factor_type", ["totp"]);
export const mfaFactorStatus = pgEnum("mfa_factor_status", ["pending", "enabled", "disabled"]);
export const authActionTokenPurpose = pgEnum("auth_action_token_purpose", [
  "email_verification",
  "password_reset",
  "registration_invitation",
  "email_change",
]);
export const teamMembershipRole = pgEnum("team_membership_role", ["owner", "member"]);
export const teamInvitationStatus = pgEnum("team_invitation_status", ["pending", "accepted", "revoked"]);
export const organizationStatus = pgEnum("organization_status", ["provisioning", "active", "suspended", "archived"]);
export const organizationMembershipRole = pgEnum("organization_membership_role", ["owner", "admin", "member"]);
export const organizationInvitationStatus = pgEnum("organization_invitation_status", ["pending", "accepted", "revoked", "expired"]);
export const architectureTargetStatus = pgEnum("architecture_target_status", ["connected", "degraded", "revoked"]);
export const architectureTargetConsentStatus = pgEnum("architecture_target_consent_status", ["pending", "granted", "denied", "revoked"]);
export const skillUpgradePolicyScope = pgEnum("skill_upgrade_policy_scope", ["target", "organization"]);
export const architectureSyncRunKind = pgEnum("architecture_sync_run_kind", ["preview", "sync", "recovery", "rollback"]);
export const architectureSyncRunStatus = pgEnum("architecture_sync_run_status", [
  "drafted",
  "awaiting_approval",
  "approved",
  "queued",
  "lease_acquiring",
  "revalidating",
  "preparing",
  "applying",
  "verifying",
  "succeeded",
  "blocked",
  "failed",
  "rollback_required",
  "rolling_back",
  "rolled_back",
  "rollback_failed",
  "cancelled",
  "expired",
]);
export const architectureSyncStepAction = pgEnum("architecture_sync_step_action", [
  "noop",
  "install",
  "update",
  "downgrade",
  "enable",
  "disable",
  "remove",
  "conflict",
  "unsupported",
  "configure-router",
]);
export const architectureSyncStepStatus = pgEnum("architecture_sync_step_status", [
  "planned",
  "prepared",
  "started",
  "succeeded",
  "verify_failed",
  "compensating",
  "compensated",
  "failed",
  "skipped",
]);
export const architectureSyncFailureClass = pgEnum("architecture_sync_failure_class", [
  "validation",
  "authorization",
  "consent",
  "stale-target",
  "digest-mismatch",
  "conflict",
  "unsupported",
  "lease-lost",
  "transient",
  "verification",
  "mutation",
  "rollback",
  "ambiguous-readback",
  "irreversible",
  "unrecoverable",
]);
export const architectureSyncLeaseStatus = pgEnum("architecture_sync_lease_status", ["active", "released", "expired"]);
export const architectureSyncReceiptKind = pgEnum("architecture_sync_receipt_kind", [
  "run",
  "step",
  "lease",
  "approval",
  "baseline",
  "apply",
  "verify",
  "rollback",
  "recovery",
]);
export const architectureSyncReceiptStatus = pgEnum("architecture_sync_receipt_status", [
  "accepted",
  "started",
  "succeeded",
  "failed",
  "skipped",
  "unknown",
]);
export const architectureSyncRecoveryCondition = pgEnum("architecture_sync_recovery_condition", [
  "no-mutation",
  "desired-readback",
  "restorable-partial-state",
  "ambiguous-readback",
  "irreversible-unrecoverable",
]);
export const architectureSyncRecoveryDecision = pgEnum("architecture_sync_recovery_decision", [
  "retry",
  "succeed",
  "rollback",
  "block",
  "manual-intervention",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  normalizedEmail: text("normalized_email").notNull().unique(),
  name: text("name").notNull().default(""),
  status: userStatus("status").notNull().default("pending"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  ...timestamps,
});

export const passwordCredentials = pgTable("password_credentials", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(),
  passwordUpdatedAt: timestamp("password_updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  mfaVerifiedAt: timestamp("mfa_verified_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenPrefix: text("token_prefix").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  scopes: jsonb("scopes").notNull().default([]),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  mfaVerifiedAt: timestamp("mfa_verified_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mfaFactors = pgTable("mfa_factors", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: mfaFactorType("type").notNull().default("totp"),
  status: mfaFactorStatus("status").notNull().default("pending"),
  label: text("label").notNull().default("Authenticator app"),
  secretCiphertext: text("secret_ciphertext").notNull(),
  enabledAt: timestamp("enabled_at", { withTimezone: true }),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  lastUsedCounter: integer("last_used_counter"),
  ...timestamps,
}, (table) => [
  index("mfa_factors_user_idx").on(table.userId),
  index("mfa_factors_enabled_idx").on(table.userId, table.status),
]);

export const mfaRecoveryCodes = pgTable("mfa_recovery_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull().unique(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("mfa_recovery_codes_user_idx").on(table.userId),
]);

export const mfaChallenges = pgTable("mfa_challenges", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("mfa_challenges_user_idx").on(table.userId),
  index("mfa_challenges_active_idx").on(table.tokenHash, table.expiresAt).where(sql`${table.usedAt} IS NULL`),
]);

export const authActionTokens = pgTable("auth_action_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  purpose: authActionTokenPurpose("purpose").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  sentToNormalizedEmail: text("sent_to_normalized_email").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("auth_action_tokens_user_purpose_idx").on(table.userId, table.purpose),
  index("auth_action_tokens_active_idx").on(table.tokenHash, table.purpose, table.expiresAt).where(sql`${table.usedAt} IS NULL`),
]);

export const authRateLimits = pgTable("auth_rate_limits", {
  bucketKey: text("bucket_key").primaryKey(),
  attemptCount: integer("attempt_count").notNull().default(0),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: roleName("name").notNull().unique(),
  description: text("description").notNull().default(""),
});

export const roleAssignments = pgTable("role_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: roleName("role").notNull(),
  scopeType: text("scope_type").notNull().default("instance"),
  scopeId: uuid("scope_id").notNull().default(sql`'00000000-0000-0000-0000-000000000000'::uuid`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.userId, table.role, table.scopeType, table.scopeId)]);

export const instanceSettings = pgTable("instance_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  ...timestamps,
});

export const organizationPolicyRevisions = pgTable("organization_policy_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The migration is canonical for the policy table's organization FK and
  // deferrable behavior. The composite same-org current-policy FK is declared
  // on organizations below.
  organizationId: uuid("organization_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  policy: jsonb("policy").notNull(),
  policySha256: text("policy_sha256").notNull(),
  reason: text("reason").notNull().default(""),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("organization_policy_revisions_org_idx").on(table.organizationId, table.revisionNumber),
  unique("organization_policy_revisions_org_revision_unique").on(table.organizationId, table.revisionNumber),
  unique("organization_policy_revisions_org_id_unique").on(table.organizationId, table.id),
  unique("organization_policy_revisions_org_digest_unique").on(table.organizationId, table.policySha256),
  check("organization_policy_revisions_revision_number_check", sql`${table.revisionNumber} > 0`),
  check("organization_policy_revisions_schema_version_check", sql`${table.schemaVersion} = 1`),
  check(
    "organization_policy_revisions_policy_check",
    sql`jsonb_typeof(${table.policy}) = 'object' AND ${table.policy} @> '{"schemaVersion": 1}'::jsonb`,
  ),
  check("organization_policy_revisions_policy_sha256_check", sql`${table.policySha256} ~ '^[0-9a-f]{64}$'`),
  check("organization_policy_revisions_reason_check", sql`length(${table.reason}) <= 500`),
]);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  status: organizationStatus("status").notNull().default("provisioning"),
  currentPolicyRevisionId: uuid("current_policy_revision_id"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
}, (table) => [
  index("organizations_status_idx").on(table.status, table.updatedAt),
  check("organizations_name_check", sql`length(${table.name}) BETWEEN 2 AND 120`),
  check("organizations_slug_check", sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  check(
    "organizations_active_requires_policy_check",
    sql`${table.status} <> 'active' OR ${table.currentPolicyRevisionId} IS NOT NULL`,
  ),
  foreignKey({
    name: "organizations_current_policy_revision_fk",
    columns: [table.id, table.currentPolicyRevisionId],
    foreignColumns: [organizationPolicyRevisions.organizationId, organizationPolicyRevisions.id],
  }),
]);

export const organizationMemberships = pgTable("organization_memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: organizationMembershipRole("role").notNull().default("member"),
  invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("organization_memberships_org_user_unique").on(table.organizationId, table.userId),
  index("organization_memberships_active_user_idx")
    .on(table.userId, table.organizationId)
    .where(sql`${table.removedAt} IS NULL`),
  index("organization_memberships_active_org_idx")
    .on(table.organizationId, table.userId)
    .where(sql`${table.removedAt} IS NULL`),
]);

export const organizationInvitations = pgTable("organization_invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  email: text("email").notNull(),
  normalizedEmail: text("normalized_email").notNull(),
  role: organizationMembershipRole("role").notNull().default("member"),
  status: organizationInvitationStatus("status").notNull().default("pending"),
  invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
  acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, { onDelete: "set null" }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  index("organization_invitations_recipient_idx").on(table.normalizedEmail, table.status),
  index("organization_invitations_org_idx").on(table.organizationId, table.status, table.createdAt),
  uniqueIndex("organization_invitations_pending_unique_idx")
    .on(table.organizationId, table.normalizedEmail)
    .where(sql`${table.status} = 'pending'`),
]);

export const teams = pgTable("teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "restrict" }),
  ...timestamps,
}, (table) => [
  index("teams_created_by_idx").on(table.createdByUserId),
  index("teams_organization_idx").on(table.organizationId).where(sql`${table.organizationId} IS NOT NULL`),
]);

export const teamMemberships = pgTable("team_memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: teamMembershipRole("role").notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("team_memberships_user_idx").on(table.userId),
  unique().on(table.teamId, table.userId),
]);

export const teamInvitations = pgTable("team_invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  normalizedEmail: text("normalized_email").notNull(),
  invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
  status: teamInvitationStatus("status").notNull().default("pending"),
  acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, { onDelete: "set null" }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  index("team_invitations_recipient_idx").on(table.normalizedEmail, table.status),
  unique().on(table.teamId, table.normalizedEmail),
]);

export const providerConfigs = pgTable("provider_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  type: providerType("type").notNull(),
  displayName: text("display_name").notNull(),
  issuer: text("issuer"),
  clientId: text("client_id"),
  enabled: boolean("enabled").notNull().default(false),
  ...timestamps,
}, (table) => [
  index("provider_configs_key_idx").on(table.key),
]);

export const providerRoleMappings = pgTable("provider_role_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerConfigId: uuid("provider_config_id").notNull().references(() => providerConfigs.id, { onDelete: "cascade" }),
  claim: text("claim").notNull(),
  value: text("value").notNull(),
  role: roleName("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("provider_role_mappings_provider_idx").on(table.providerConfigId),
  unique().on(table.providerConfigId, table.claim, table.value, table.role),
]);

export const skills = pgTable("skills", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  lifecycleStatus: skillLifecycleStatus("lifecycle_status").notNull().default("draft"),
  visibility: visibilityScope("visibility").notNull().default("private"),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
});

export const skillVersions = pgTable("skill_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  skillId: uuid("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  releaseNotes: text("release_notes").notNull().default(""),
  changeKind: text("change_kind").$type<SkillReleaseChangeKind>().notNull().default("maintenance"),
  requiresUserAction: boolean("requires_user_action").notNull().default(false),
  compatibility: jsonb("compatibility").$type<SkillReleaseCompatibility>().notNull().default({}),
  lifecycleStatus: skillLifecycleStatus("lifecycle_status").notNull().default("submitted"),
  reviewStatus: reviewStatus("review_status").notNull().default("unreviewed"),
  securityStatus: securityStatus("security_status").notNull().default("not-run"),
  approvedArtifactSha256: text("approved_artifact_sha256"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  lifecycleReason: text("lifecycle_reason").notNull().default(""),
  lifecycleUpdatedAt: timestamp("lifecycle_updated_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("skill_versions_lifecycle_idx").on(table.lifecycleStatus),
  index("skill_versions_review_queue_idx")
    .on(table.createdAt)
    .where(sql`${table.reviewStatus} IN ('unreviewed', 'changes-requested') OR (${table.reviewStatus} = 'approved' AND ${table.publishedAt} IS NULL)`),
  unique().on(table.skillId, table.version),
]);

export const skillPlatformVariants = pgTable("skill_platform_variants", {
  id: uuid("id").primaryKey().defaultRandom(),
  skillVersionId: uuid("skill_version_id").notNull().references(() => skillVersions.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  installTarget: text("install_target").notNull(),
  status: text("status").notNull().default("supported"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.skillVersionId, table.name)]);

export const skillArtifacts = pgTable("skill_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  skillVersionId: uuid("skill_version_id").notNull().references(() => skillVersions.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull().unique(),
  sha256: text("sha256").notNull(),
  byteSize: integer("byte_size").notNull(),
  contentType: text("content_type").notNull(),
  payload: jsonb("payload").notNull().default({ files: [] }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique("skill_artifacts_skill_version_unique").on(table.skillVersionId)]);

export const artifactWriteIntents = pgTable("artifact_write_intents", {
  storageKey: text("storage_key").primaryKey(),
  state: text("state").notNull().default("reserved"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  ...timestamps,
}, (table) => [index("artifact_write_intents_state_idx").on(table.state, table.updatedAt)]);

export const skillTags = pgTable("skill_tags", {
  skillId: uuid("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  tag: text("tag").notNull(),
}, (table) => [unique().on(table.skillId, table.tag)]);

export const skillTeamGrants = pgTable("skill_team_grants", {
  skillId: uuid("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("skill_team_grants_team_idx").on(table.teamId),
  unique().on(table.skillId, table.teamId),
]);

export const skillOrganizationGrants = pgTable("skill_organization_grants", {
  skillId: uuid("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdUnderPolicyRevisionId: uuid("created_under_policy_revision_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("skill_organization_grants_org_idx").on(table.organizationId, table.skillId),
  primaryKey({ name: "skill_organization_grants_pkey", columns: [table.skillId, table.organizationId] }),
  foreignKey({
    name: "skill_organization_grants_policy_revision_fk",
    columns: [table.organizationId, table.createdUnderPolicyRevisionId],
    foreignColumns: [organizationPolicyRevisions.organizationId, organizationPolicyRevisions.id],
  }),
]);

export const skillUserGrants = pgTable("skill_user_grants", {
  skillId: uuid("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("skill_user_grants_user_idx").on(table.userId),
  unique().on(table.skillId, table.userId),
]);

export const scanRuns = pgTable("scan_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  skillVersionId: uuid("skill_version_id").references(() => skillVersions.id, { onDelete: "cascade" }),
  status: jobStatus("status").notNull().default("queued"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("scan_runs_skill_version_idx").on(table.skillVersionId)]);

export const scanFindings = pgTable("scan_findings", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanRunId: uuid("scan_run_id").notNull().references(() => scanRuns.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  severity: text("severity").notNull(),
  message: text("message").notNull(),
  path: text("path"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("scan_findings_scan_run_idx").on(table.scanRunId)]);

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(),
  status: jobStatus("status").notNull().default("queued"),
  payload: jsonb("payload").notNull().default({}),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
});

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  decision: text("decision").notNull(),
  resourceType: text("resource_type").notNull().default(""),
  resourceId: uuid("resource_id"),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const skillArchitectures = pgTable("skill_architectures", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
  ownerTeamId: uuid("owner_team_id").references(() => teams.id, { onDelete: "restrict" }),
  accessPolicyVersion: integer("access_policy_version").notNull().default(1),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  patternId: text("pattern_id").notNull(),
  currentRevisionId: uuid("current_revision_id"),
  ...timestamps,
}, (table) => [
  index("skill_architectures_owner_user_idx")
    .on(table.ownerUserId, table.updatedAt)
    .where(sql`${table.ownerUserId} IS NOT NULL`),
  index("skill_architectures_owner_team_idx")
    .on(table.ownerTeamId, table.updatedAt)
    .where(sql`${table.ownerTeamId} IS NOT NULL`),
  check(
    "skill_architectures_exactly_one_owner_check",
    sql`(${table.ownerUserId} IS NOT NULL) <> (${table.ownerTeamId} IS NOT NULL)`,
  ),
  check(
    "skill_architectures_access_policy_version_check",
    sql`${table.accessPolicyVersion} = 1`,
  ),
]);

export const skillArchitectureRevisions = pgTable("skill_architecture_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  architectureId: uuid("architecture_id").notNull().references(() => skillArchitectures.id, { onDelete: "cascade" }),
  revisionNumber: integer("revision_number").notNull(),
  message: text("message").notNull().default(""),
  spec: jsonb("spec").notNull(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("skill_architecture_revisions_architecture_idx").on(table.architectureId, table.revisionNumber),
  unique("skill_architecture_revisions_number_unique").on(table.architectureId, table.revisionNumber),
  unique("skill_architecture_revisions_architecture_id_id_unique").on(table.architectureId, table.id),
]);

export const skillArchitecturePatternMigrations = pgTable("skill_architecture_pattern_migrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  schemaVersion: integer("schema_version").notNull().default(1),
  mode: text("mode").notNull().default("derive-shell"),
  sourceArchitectureId: uuid("source_architecture_id").notNull(),
  sourceRevisionId: uuid("source_revision_id").notNull(),
  sourcePatternId: text("source_pattern_id").notNull(),
  sourceRevisionDigest: text("source_revision_digest").notNull(),
  targetArchitectureId: uuid("target_architecture_id").notNull(),
  targetRevisionId: uuid("target_revision_id").notNull(),
  targetPatternId: text("target_pattern_id").notNull(),
  targetRevisionDigest: text("target_revision_digest").notNull(),
  mappingStatus: text("mapping_status").notNull(),
  mapping: jsonb("mapping").notNull().default({}),
  diff: jsonb("diff").notNull().default({}),
  migrationDigest: text("migration_digest").notNull(),
  diffDigest: text("diff_digest").notNull(),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    name: "skill_architecture_pattern_migrations_source_revision_fk",
    columns: [table.sourceArchitectureId, table.sourceRevisionId],
    foreignColumns: [skillArchitectureRevisions.architectureId, skillArchitectureRevisions.id],
  }),
  foreignKey({
    name: "skill_architecture_pattern_migrations_target_revision_fk",
    columns: [table.targetArchitectureId, table.targetRevisionId],
    foreignColumns: [skillArchitectureRevisions.architectureId, skillArchitectureRevisions.id],
  }),
  check("skill_architecture_pattern_migrations_schema_version_check", sql`${table.schemaVersion} = 1`),
  check("skill_architecture_pattern_migrations_mode_check", sql`${table.mode} = 'derive-shell'`),
  check(
    "skill_architecture_pattern_migrations_distinct_arch_check",
    sql`${table.sourceArchitectureId} <> ${table.targetArchitectureId}`,
  ),
  check(
    "skill_architecture_pattern_migrations_source_pattern_check",
    sql`${table.sourcePatternId} IN ('flat', 'domain-router', 'multi-level-router')`,
  ),
  check(
    "skill_architecture_pattern_migrations_target_pattern_check",
    sql`${table.targetPatternId} IN ('flat', 'domain-router', 'multi-level-router')`,
  ),
  check(
    "skill_architecture_pattern_migrations_mapping_status_check",
    sql`${table.mappingStatus} IN ('deterministic', 'fallback', 'provided')`,
  ),
  check(
    "skill_architecture_pattern_migrations_mapping_check",
    sql`architecture_pattern_migration_mapping_is_safe(${table.mapping})`,
  ),
  check(
    "skill_architecture_pattern_migrations_diff_check",
    sql`architecture_pattern_migration_diff_is_safe(${table.diff})`,
  ),
  check(
    "skill_architecture_pattern_migrations_source_digest_check",
    sql`${table.sourceRevisionDigest} ~ '^[0-9a-f]{64}$'`,
  ),
  check(
    "skill_architecture_pattern_migrations_target_digest_check",
    sql`${table.targetRevisionDigest} ~ '^[0-9a-f]{64}$'`,
  ),
  check(
    "skill_architecture_pattern_migrations_migration_digest_check",
    sql`${table.migrationDigest} ~ '^[0-9a-f]{64}$'`,
  ),
  check(
    "skill_architecture_pattern_migrations_diff_digest_check",
    sql`${table.diffDigest} ~ '^[0-9a-f]{64}$'`,
  ),
  check(
    "skill_architecture_pattern_migrations_idempotency_key_check",
    sql`${table.idempotencyKey} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
  ),
  index("skill_architecture_pattern_migrations_source_history_idx")
    .on(table.sourceArchitectureId, table.sourceRevisionId, table.createdAt, table.id),
  index("skill_architecture_pattern_migrations_actor_history_idx")
    .on(table.actorUserId, table.createdAt, table.id),
  unique("skill_architecture_pattern_migrations_actor_idempotency_unique")
    .on(table.actorUserId, table.idempotencyKey),
  unique("skill_architecture_pattern_migrations_target_arch_unique")
    .on(table.targetArchitectureId),
  unique("skill_architecture_pattern_migrations_target_revision_unique")
    .on(table.targetRevisionId),
]);

export const skillArchitectureOrganizationGrants = pgTable("skill_architecture_organization_grants", {
  architectureId: uuid("architecture_id").notNull().references(() => skillArchitectures.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  accessLevel: text("access_level").notNull().default("read"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdUnderPolicyRevisionId: uuid("created_under_policy_revision_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("skill_architecture_organization_grants_org_idx").on(table.organizationId, table.architectureId),
  primaryKey({ name: "skill_architecture_organization_grants_pkey", columns: [table.architectureId, table.organizationId] }),
  check(
    "skill_architecture_organization_grants_access_level_check",
    sql`${table.accessLevel} = 'read'`,
  ),
  foreignKey({
    name: "skill_architecture_organization_grants_policy_revision_fk",
    columns: [table.organizationId, table.createdUnderPolicyRevisionId],
    foreignColumns: [organizationPolicyRevisions.organizationId, organizationPolicyRevisions.id],
  }),
]);

export const skillArchitectureTargets = pgTable("skill_architecture_targets", {
  id: uuid("id").primaryKey().defaultRandom(),
  schemaVersion: integer("schema_version").notNull().default(1),
  architectureId: uuid("architecture_id").notNull().references(() => skillArchitectures.id, { onDelete: "restrict" }),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
  ownerTeamId: uuid("owner_team_id").references(() => teams.id, { onDelete: "restrict" }),
  ownerOrganizationId: uuid("owner_organization_id").references(() => organizations.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  adapterKind: text("adapter_kind").notNull(),
  adapterContractVersion: integer("adapter_contract_version").notNull().default(1),
  adapterVersion: text("adapter_version").notNull(),
  environmentId: text("environment_id").notNull(),
  profileId: text("profile_id").notNull(),
  status: architectureTargetStatus("status").notNull().default("degraded"),
  consentStatus: architectureTargetConsentStatus("consent_status").notNull().default("pending"),
  consentRequestedAt: timestamp("consent_requested_at", { withTimezone: true }).notNull().defaultNow(),
  consentGrantedAt: timestamp("consent_granted_at", { withTimezone: true }),
  consentDeniedAt: timestamp("consent_denied_at", { withTimezone: true }),
  consentRevokedAt: timestamp("consent_revoked_at", { withTimezone: true }),
  capabilities: jsonb("capabilities").notNull().default({}),
  capabilitiesDigest: text("capabilities_digest").notNull(),
  identityDigest: text("identity_digest").notNull(),
  generation: integer("generation").notNull().default(1),
  metadata: jsonb("metadata").notNull().default({}),
  healthSummary: jsonb("health_summary").notNull().default({}),
  credentialReference: text("credential_reference"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
}, (table) => [
  index("skill_architecture_targets_owner_user_idx")
    .on(table.ownerUserId, table.updatedAt)
    .where(sql`${table.ownerUserId} IS NOT NULL`),
  index("skill_architecture_targets_owner_team_idx")
    .on(table.ownerTeamId, table.updatedAt)
    .where(sql`${table.ownerTeamId} IS NOT NULL`),
  index("skill_architecture_targets_owner_organization_idx")
    .on(table.ownerOrganizationId, table.updatedAt)
    .where(sql`${table.ownerOrganizationId} IS NOT NULL`),
  index("skill_architecture_targets_status_idx").on(table.status, table.updatedAt),
  index("skill_architecture_targets_architecture_binding_idx")
    .on(table.architectureId, table.environmentId, table.profileId, table.updatedAt),
  unique("skill_architecture_targets_id_architecture_id_unique").on(table.id, table.architectureId),
  unique("skill_architecture_targets_id_generation_unique").on(table.id, table.generation),
  check(
    "skill_architecture_targets_schema_version_check",
    sql`${table.schemaVersion} = 1`,
  ),
  check(
    "skill_architecture_targets_exactly_one_owner_check",
    sql`num_nonnulls(${table.ownerUserId}, ${table.ownerTeamId}, ${table.ownerOrganizationId}) = 1`,
  ),
  check(
    "skill_architecture_targets_name_check",
    sql`length(${table.name}) BETWEEN 1 AND 120`,
  ),
  check(
    "skill_architecture_targets_adapter_kind_check",
    sql`${table.adapterKind} ~ '^[a-z][a-z0-9._-]{0,63}$'`,
  ),
  check(
    "skill_architecture_targets_adapter_contract_version_check",
    sql`${table.adapterContractVersion} IN (1, 2)`,
  ),
  check(
    "skill_architecture_targets_adapter_version_check",
    sql`length(${table.adapterVersion}) BETWEEN 1 AND 64 AND ${table.adapterVersion} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'`,
  ),
  check(
    "skill_architecture_targets_environment_id_check",
    sql`${table.environmentId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
  ),
  check(
    "skill_architecture_targets_profile_id_check",
    sql`${table.profileId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
  ),
  check(
    "skill_architecture_targets_capabilities_object_check",
    sql`jsonb_typeof(${table.capabilities}) = 'object'`,
  ),
  check(
    "skill_architecture_targets_capabilities_keys_check",
    sql`(${table.capabilities} - ARRAY['inventory.read', 'health.read', 'plan.read', 'apply', 'rollback', 'sync.write']::text[]) = '{}'::jsonb`,
  ),
  check(
    "skill_architecture_targets_capabilities_boolean_values_check",
    sql`(NOT ${table.capabilities} ? 'inventory.read' OR jsonb_typeof(${table.capabilities} -> 'inventory.read') = 'boolean') AND (NOT ${table.capabilities} ? 'health.read' OR jsonb_typeof(${table.capabilities} -> 'health.read') = 'boolean') AND (NOT ${table.capabilities} ? 'plan.read' OR jsonb_typeof(${table.capabilities} -> 'plan.read') = 'boolean') AND (NOT ${table.capabilities} ? 'apply' OR jsonb_typeof(${table.capabilities} -> 'apply') = 'boolean') AND (NOT ${table.capabilities} ? 'rollback' OR jsonb_typeof(${table.capabilities} -> 'rollback') = 'boolean') AND (NOT ${table.capabilities} ? 'sync.write' OR jsonb_typeof(${table.capabilities} -> 'sync.write') = 'boolean')`,
  ),
  check(
    "skill_architecture_targets_capabilities_mutation_disabled_check",
    sql`(${table.adapterContractVersion} = 1 AND (NOT ${table.capabilities} ? 'apply' OR ${table.capabilities} -> 'apply' = 'false'::jsonb) AND (NOT ${table.capabilities} ? 'rollback' OR ${table.capabilities} -> 'rollback' = 'false'::jsonb) AND (NOT ${table.capabilities} ? 'sync.write' OR ${table.capabilities} -> 'sync.write' = 'false'::jsonb)) OR (${table.adapterContractVersion} = 2 AND (COALESCE((${table.capabilities} ->> 'apply')::boolean, false) = false AND COALESCE((${table.capabilities} ->> 'rollback')::boolean, false) = false OR ${table.capabilities} -> 'sync.write' = 'true'::jsonb))`,
  ),
  check(
    "skill_architecture_targets_capabilities_safe_check",
    sql`${table.capabilities}::text !~* '(^|[^a-z])(api[_-]?key|authorization|cookie|password|secret|token|credential|private[_-]?key)([^a-z]|$)' AND ${table.capabilities}::text !~* '(https?://|ftp://|file://)'`,
  ),
  check(
    "skill_architecture_targets_capabilities_digest_check",
    sql`${table.capabilitiesDigest} ~ '^[0-9a-f]{64}$'`,
  ),
  check(
    "skill_architecture_targets_identity_digest_check",
    sql`${table.identityDigest} ~ '^[0-9a-f]{64}$'`,
  ),
  check(
    "skill_architecture_targets_generation_check",
    sql`${table.generation} BETWEEN 1 AND 1000000000`,
  ),
  check(
    "skill_architecture_targets_metadata_object_check",
    sql`jsonb_typeof(${table.metadata}) = 'object'`,
  ),
  check(
    "skill_architecture_targets_metadata_safe_check",
    sql`${table.metadata}::text !~* '(^|[^a-z])(api[_-]?key|authorization|cookie|password|secret|token|credential|private[_-]?key|prompt|path|endpoint|url|package|content|config|root|body|source|raw|snapshot|payload|file|filename|directory|home|host|machine)([^a-z]|$)' AND ${table.metadata}::text !~* '(https?://|ftp://|file://)' AND ${table.metadata}::text !~* '(^|[^a-z0-9])/(Users|home|root|private|var|tmp|etc|opt|workspace|mnt|Volumes)(/|[^a-z0-9]|$)' AND ${table.metadata}::text !~* '(^|[^a-z0-9])(\.{1,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|localhost(:[0-9]+)?[\\/]|127\.0\.0\.1(:[0-9]+)?[\\/])'`,
  ),
  check(
    "skill_architecture_targets_health_summary_object_check",
    sql`jsonb_typeof(${table.healthSummary}) = 'object'`,
  ),
  check(
    "skill_architecture_targets_health_summary_safe_check",
    sql`${table.healthSummary}::text !~* '(^|[^a-z])(api[_-]?key|authorization|cookie|password|secret|token|credential|private[_-]?key|prompt|path|endpoint|url|package|content|config|root|body|source|raw|snapshot|payload|file|filename|directory|home|host|machine)([^a-z]|$)' AND ${table.healthSummary}::text !~* '(https?://|ftp://|file://)' AND ${table.healthSummary}::text !~* '(^|[^a-z0-9])/(Users|home|root|private|var|tmp|etc|opt|workspace|mnt|Volumes)(/|[^a-z0-9]|$)' AND ${table.healthSummary}::text !~* '(^|[^a-z0-9])(\.{1,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|localhost(:[0-9]+)?[\\/]|127\.0\.0\.1(:[0-9]+)?[\\/])'`,
  ),
  check(
    "skill_architecture_targets_consent_granted_at_check",
    sql`${table.consentStatus} <> 'granted' OR ${table.consentGrantedAt} IS NOT NULL`,
  ),
  check(
    "skill_architecture_targets_consent_denied_at_check",
    sql`${table.consentStatus} <> 'denied' OR ${table.consentDeniedAt} IS NOT NULL`,
  ),
  check(
    "skill_architecture_targets_consent_revoked_at_check",
    sql`${table.consentStatus} <> 'revoked' OR ${table.consentRevokedAt} IS NOT NULL`,
  ),
  check(
    "skill_architecture_targets_consent_revoked_state_check",
    sql`${table.consentRevokedAt} IS NULL OR ${table.consentStatus} = 'revoked'`,
  ),
  check(
    "skill_architecture_targets_connected_consent_check",
    sql`${table.status} <> 'connected' OR ${table.consentStatus} = 'granted'`,
  ),
  check(
    "skill_architecture_targets_revoked_consent_check",
    sql`${table.status} <> 'revoked' OR ${table.consentStatus} = 'revoked'`,
  ),
  check(
    "skill_architecture_targets_consent_revoked_status_check",
    sql`${table.consentStatus} <> 'revoked' OR ${table.status} = 'revoked'`,
  ),
  check(
    "skill_architecture_targets_credential_reference_check",
    sql`${table.credentialReference} IS NULL OR ${table.credentialReference} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'`,
  ),
]);

export const skillArchitectureObservations = pgTable("skill_architecture_observations", {
  id: uuid("id").primaryKey().defaultRandom(),
  schemaVersion: integer("schema_version").notNull().default(1),
  targetId: uuid("target_id").notNull().references(() => skillArchitectureTargets.id, { onDelete: "restrict" }),
  generation: integer("generation").notNull(),
  adapterKind: text("adapter_kind").notNull(),
  adapterContractVersion: integer("adapter_contract_version").notNull(),
  adapterVersion: text("adapter_version").notNull(),
  adapterDigest: text("adapter_digest").notNull(),
  capabilitiesDigest: text("capabilities_digest").notNull(),
  observedDigest: text("observed_digest").notNull(),
  observedState: jsonb("observed_state").notNull(),
  counts: jsonb("counts").notNull().default({}),
  healthSummary: jsonb("health_summary").notNull().default({}),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("skill_architecture_observations_target_captured_idx")
    .on(table.targetId, table.capturedAt, table.id),
  unique("skill_architecture_observations_target_id_id_generation_unique")
    .on(table.targetId, table.id, table.generation),
  check(
    "skill_architecture_observations_schema_version_check",
    sql`${table.schemaVersion} = 1`,
  ),
  check(
    "skill_architecture_observations_generation_check",
    sql`${table.generation} BETWEEN 1 AND 1000000000`,
  ),
  check(
    "skill_architecture_observations_adapter_kind_check",
    sql`${table.adapterKind} ~ '^[a-z][a-z0-9._-]{0,63}$'`,
  ),
  check(
    "skill_architecture_observations_adapter_contract_version_check",
    sql`${table.adapterContractVersion} IN (1, 2)`,
  ),
  check(
    "skill_architecture_observations_adapter_version_check",
    sql`length(${table.adapterVersion}) BETWEEN 1 AND 64 AND ${table.adapterVersion} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'`,
  ),
  check(
    "skill_architecture_observations_adapter_digest_check",
    sql`${table.adapterDigest} ~ '^[0-9a-f]{64}$'`,
  ),
  check(
    "skill_architecture_observations_capabilities_digest_check",
    sql`${table.capabilitiesDigest} ~ '^[0-9a-f]{64}$'`,
  ),
  check(
    "skill_architecture_observations_observed_digest_check",
    sql`${table.observedDigest} ~ '^[0-9a-f]{64}$'`,
  ),
  check(
    "skill_architecture_observations_observed_state_object_check",
    sql`jsonb_typeof(${table.observedState}) = 'object'`,
  ),
  check(
    "skill_architecture_observations_observed_state_safe_check",
    sql`${table.observedState}::text !~* '(^|[^a-z])(api[_-]?key|authorization|cookie|password|secret|token|credential|private[_-]?key|prompt|path|endpoint|url|package|content|config|body|source|raw|snapshot|payload|file|filename|directory|home|host|machine)([^a-z]|$)' AND ${table.observedState}::text !~* '"root"[[:space:]]*:' AND ${table.observedState}::text !~* '(https?://|ftp://|file://)' AND ${table.observedState}::text !~* '(^|[^a-z0-9])/(Users|home|root|private|var|tmp|etc|opt|workspace|mnt|Volumes)(/|[^a-z0-9]|$)' AND ${table.observedState}::text !~* '(^|[^a-z0-9])(\.{1,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|localhost(:[0-9]+)?[\\/]|127\.0\.0\.1(:[0-9]+)?[\\/])'`,
  ),
  check(
    "skill_architecture_observations_counts_object_check",
    sql`jsonb_typeof(${table.counts}) = 'object'`,
  ),
  check(
    "skill_architecture_observations_counts_safe_check",
    sql`${table.counts}::text !~* '(^|[^a-z])(api[_-]?key|authorization|cookie|password|secret|token|credential|private[_-]?key|prompt|path|endpoint|url|package|content|config|root|body|source|raw|snapshot|payload|file|filename|directory|home|host|machine)([^a-z]|$)' AND ${table.counts}::text !~* '(https?://|ftp://|file://)' AND ${table.counts}::text !~* '(^|[^a-z0-9])/(Users|home|root|private|var|tmp|etc|opt|workspace|mnt|Volumes)(/|[^a-z0-9]|$)' AND ${table.counts}::text !~* '(^|[^a-z0-9])(\.{1,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|localhost(:[0-9]+)?[\\/]|127\.0\.0\.1(:[0-9]+)?[\\/])'`,
  ),
  check(
    "skill_architecture_observations_health_summary_object_check",
    sql`jsonb_typeof(${table.healthSummary}) = 'object'`,
  ),
  check(
    "skill_architecture_observations_health_summary_safe_check",
    sql`${table.healthSummary}::text !~* '(^|[^a-z])(api[_-]?key|authorization|cookie|password|secret|token|credential|private[_-]?key|prompt|path|endpoint|url|package|content|config|root|body|source|raw|snapshot|payload|file|filename|directory|home|host|machine)([^a-z]|$)' AND ${table.healthSummary}::text !~* '(https?://|ftp://|file://)' AND ${table.healthSummary}::text !~* '(^|[^a-z0-9])/(Users|home|root|private|var|tmp|etc|opt|workspace|mnt|Volumes)(/|[^a-z0-9]|$)' AND ${table.healthSummary}::text !~* '(^|[^a-z0-9])(\.{1,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|localhost(:[0-9]+)?[\\/]|127\.0\.0\.1(:[0-9]+)?[\\/])'`,
  ),
]);

export const targetSkillOperations = pgTable("target_skill_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  schemaVersion: integer("schema_version").notNull().default(1),
  targetId: uuid("target_id").notNull().references(() => skillArchitectureTargets.id, { onDelete: "restrict" }),
  targetGeneration: integer("target_generation").notNull(),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  action: text("action").notNull(),
  skillSlug: text("skill_slug").notNull(),
  fromVersion: text("from_version"),
  toVersion: text("to_version").notNull(),
  platform: text("platform").notNull(),
  artifactSha256: text("artifact_sha256").notNull(),
  artifactByteSize: bigint("artifact_byte_size", { mode: "number" }).notNull(),
  artifactContentType: text("artifact_content_type").notNull(),
  planDigest: text("plan_digest").notNull(),
  state: text("state").notNull().default("queued"),
  fencingToken: integer("fencing_token").notNull().default(0),
  holderId: text("holder_id"),
  claimTokenHash: text("claim_token_hash"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  result: jsonb("result").$type<TargetSkillOperationResult>(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("target_skill_operations_target_history_idx").on(table.targetId, table.createdAt, table.id),
  index("target_skill_operations_success_idx").on(table.targetId, table.targetGeneration, table.skillSlug, table.updatedAt, table.id).where(sql`${table.state} = 'succeeded'`),
  index("target_skill_operations_queue_idx").on(table.targetId, table.createdAt, table.id).where(sql`${table.state} = 'queued'`),
  unique("target_skill_operations_target_idempotency_unique").on(table.targetId, table.idempotencyKey),
  check("target_skill_operations_schema_version_check", sql`${table.schemaVersion} = 1`),
  check("target_skill_operations_generation_check", sql`${table.targetGeneration} BETWEEN 1 AND 1000000000`),
  check("target_skill_operations_action_check", sql`${table.action} IN ('install', 'update', 'rollback')`),
  check("target_skill_operations_slug_check", sql`${table.skillSlug} ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'`),
  check("target_skill_operations_state_check", sql`${table.state} IN ('queued', 'claimed', 'applying', 'verifying', 'succeeded', 'failed', 'cancelled', 'expired')`),
  check("target_skill_operations_digest_check", sql`${table.artifactSha256} ~ '^[0-9a-f]{64}$' AND ${table.planDigest} ~ '^[0-9a-f]{64}$'`),
  check("target_skill_operations_version_check", sql`${table.toVersion} ~ '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$' AND (${table.fromVersion} IS NULL OR ${table.fromVersion} ~ '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')`),
  check("target_skill_operations_artifact_check", sql`${table.artifactByteSize} BETWEEN 1 AND 14680064 AND length(${table.artifactContentType}) BETWEEN 1 AND 120 AND ${table.artifactContentType} !~ '[[:cntrl:]]'`),
  check("target_skill_operations_platform_check", sql`${table.platform} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'`),
  check("target_skill_operations_fencing_check", sql`${table.fencingToken} BETWEEN 0 AND 1000000000`),
  check("target_skill_operations_idempotency_check", sql`${table.idempotencyKey} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`),
  check("target_skill_operations_claim_pair_check", sql`(${table.holderId} IS NULL) = (${table.claimTokenHash} IS NULL) AND (${table.claimTokenHash} IS NULL) = (${table.leaseExpiresAt} IS NULL)`),
  check("target_skill_operations_claim_state_check", sql`(${table.state} IN ('claimed', 'applying', 'verifying')) = (${table.holderId} IS NOT NULL)`),
  check("target_skill_operations_holder_check", sql`${table.holderId} IS NULL OR ${table.holderId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`),
  check("target_skill_operations_claim_hash_check", sql`${table.claimTokenHash} IS NULL OR ${table.claimTokenHash} ~ '^[0-9a-f]{64}$'`),
  check("target_skill_operations_result_state_check", sql`(${table.state} IN ('succeeded', 'failed')) = (${table.result} IS NOT NULL)`),
  check("target_skill_operations_result_check", sql`${table.result} IS NULL OR (jsonb_typeof(${table.result}) = 'object' AND ${table.result} - ARRAY['status', 'code', 'recordedAt', 'installedVersion', 'artifactSha256', 'contentDigest'] = '{}'::jsonb AND ${table.result}->>'status' = ${table.state} AND ${table.result}->>'code' ~ '^[a-z][a-z0-9._:-]{0,95}$' AND ${table.result}->>'recordedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' AND (NOT ${table.result} ? 'installedVersion' OR ${table.result}->>'installedVersion' ~ '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') AND (NOT ${table.result} ? 'artifactSha256' OR ${table.result}->>'artifactSha256' ~ '^[0-9a-f]{64}$') AND (NOT ${table.result} ? 'contentDigest' OR ${table.result}->>'contentDigest' ~ '^[0-9a-f]{64}$'))`),
  check("target_skill_operations_success_evidence_check", sql`${table.state} <> 'succeeded' OR coalesce(${table.result}->>'installedVersion' = ${table.toVersion} AND ${table.result}->>'artifactSha256' = ${table.artifactSha256} AND ${table.result}->>'contentDigest' ~ '^[0-9a-f]{64}$', false)`),
  check("target_skill_operations_timestamp_check", sql`${table.updatedAt} >= ${table.createdAt}`),
]);

// A bounded companion poll advances this cursor even when candidates are temporarily blocked.
export const targetSkillOperationClaimCursors = pgTable("target_skill_operation_claim_cursors", {
  targetId: uuid("target_id").primaryKey().references(() => skillArchitectureTargets.id, { onDelete: "cascade" }),
  operationCreatedAt: timestamp("operation_created_at", { withTimezone: true }).notNull(),
  operationId: uuid("operation_id").notNull(),
});

export const skillUpgradePolicyRevisions = pgTable("skill_upgrade_policy_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  schemaVersion: integer("schema_version").notNull().default(1),
  scopeType: skillUpgradePolicyScope("scope_type").notNull(),
  scopeId: uuid("scope_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  policy: jsonb("policy").$type<SkillUpgradePolicyV1>().notNull(),
  policySha256: text("policy_sha256").notNull(),
  reason: text("reason").notNull().default(""),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("skill_upgrade_policy_revisions_scope_idx").on(table.scopeType, table.scopeId, table.revisionNumber),
  unique("skill_upgrade_policy_revisions_scope_revision_unique").on(table.scopeType, table.scopeId, table.revisionNumber),
  check("skill_upgrade_policy_revisions_schema_check", sql`${table.schemaVersion} = 1`),
  check("skill_upgrade_policy_revisions_revision_check", sql`${table.revisionNumber} BETWEEN 1 AND 1000000000`),
  check("skill_upgrade_policy_revisions_digest_check", sql`${table.policySha256} ~ '^[0-9a-f]{64}$'`),
  check("skill_upgrade_policy_revisions_reason_check", sql`length(${table.reason}) <= 500 AND ${table.reason} !~ '[[:cntrl:]]'`),
  check("skill_upgrade_policy_revisions_policy_check", sql`skill_upgrade_policy_is_safe(${table.policy}) AND pg_column_size(${table.policy}) <= 65536`),
]);

export const skillArchitectureSyncRuns = pgTable("skill_architecture_sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  schemaVersion: integer("schema_version").notNull().default(1),
  architectureId: uuid("architecture_id").notNull(),
  revisionId: uuid("revision_id").notNull(),
  targetId: uuid("target_id").notNull(),
  targetGeneration: integer("target_generation").notNull(),
  observedSnapshotId: uuid("observed_snapshot_id").notNull(),
  profileId: text("profile_id").notNull(),
  environmentId: text("environment_id").notNull(),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  runKind: architectureSyncRunKind("run_kind").notNull(),
  status: architectureSyncRunStatus("status").notNull().default("drafted"),
  requestKey: text("request_key").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  desiredDigest: text("desired_digest").notNull(),
  compiledDigest: text("compiled_digest").notNull(),
  observedDigest: text("observed_digest").notNull(),
  planDigest: text("plan_digest").notNull(),
  approvalDigest: text("approval_digest"),
  baselineDigest: text("baseline_digest"),
  failureClass: architectureSyncFailureClass("failure_class"),
  failureCode: text("failure_code"),
  failureRetryable: boolean("failure_retryable"),
  stepCount: integer("step_count").notNull().default(0),
  receiptCount: integer("receipt_count").notNull().default(0),
  recoveryEvidenceCount: integer("recovery_evidence_count").notNull().default(0),
  statusUpdatedAt: timestamp("status_updated_at", { withTimezone: true }).notNull().defaultNow(),
  awaitingApprovalAt: timestamp("awaiting_approval_at", { withTimezone: true }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  queuedAt: timestamp("queued_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  failedAt: timestamp("failed_at", { withTimezone: true }),
  rollbackRequiredAt: timestamp("rollback_required_at", { withTimezone: true }),
  rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  expiredAt: timestamp("expired_at", { withTimezone: true }),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    name: "skill_architecture_sync_runs_architecture_revision_fk",
    columns: [table.architectureId, table.revisionId],
    foreignColumns: [skillArchitectureRevisions.architectureId, skillArchitectureRevisions.id],
  }),
  foreignKey({
    name: "skill_architecture_sync_runs_target_architecture_fk",
    columns: [table.targetId, table.architectureId],
    foreignColumns: [skillArchitectureTargets.id, skillArchitectureTargets.architectureId],
  }),
  foreignKey({
    name: "skill_architecture_sync_runs_observed_snapshot_fk",
    columns: [table.targetId, table.observedSnapshotId, table.targetGeneration],
    foreignColumns: [skillArchitectureObservations.targetId, skillArchitectureObservations.id, skillArchitectureObservations.generation],
  }),
  check("skill_architecture_sync_runs_schema_version_check", sql`${table.schemaVersion} = 1`),
  check("skill_architecture_sync_runs_profile_id_check", sql`${table.profileId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`),
  check("skill_architecture_sync_runs_environment_id_check", sql`${table.environmentId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`),
  check("skill_architecture_sync_runs_generation_check", sql`${table.targetGeneration} BETWEEN 1 AND 1000000000`),
  check("skill_architecture_sync_runs_request_key_check", sql`${table.requestKey} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`),
  check("skill_architecture_sync_runs_idempotency_key_check", sql`${table.idempotencyKey} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`),
  check(
    "skill_architecture_sync_runs_digest_check",
    sql`${table.desiredDigest} ~ '^[0-9a-f]{64}$' AND ${table.compiledDigest} ~ '^[0-9a-f]{64}$' AND ${table.observedDigest} ~ '^[0-9a-f]{64}$' AND ${table.planDigest} ~ '^[0-9a-f]{64}$' AND (${table.approvalDigest} IS NULL OR ${table.approvalDigest} ~ '^[0-9a-f]{64}$') AND (${table.baselineDigest} IS NULL OR ${table.baselineDigest} ~ '^[0-9a-f]{64}$')`,
  ),
  check("skill_architecture_sync_runs_failure_pair_check", sql`(${table.failureClass} IS NULL) = (${table.failureCode} IS NULL)`),
  check("skill_architecture_sync_runs_failure_code_check", sql`${table.failureCode} IS NULL OR ${table.failureCode} ~ '^[a-z][a-z0-9._:-]{0,95}$'`),
  check(
    "skill_architecture_sync_runs_count_check",
    sql`${table.stepCount} BETWEEN 0 AND 1000000 AND ${table.receiptCount} BETWEEN 0 AND 1000000 AND ${table.recoveryEvidenceCount} BETWEEN 0 AND 1000000`,
  ),
  check("skill_architecture_sync_runs_metadata_check", sql`architecture_sync_metadata_is_safe(${table.metadata})`),
  check(
    "skill_architecture_sync_runs_timestamps_check",
    sql`${table.statusUpdatedAt} >= ${table.createdAt} AND ${table.updatedAt} >= ${table.createdAt} AND (${table.awaitingApprovalAt} IS NULL OR ${table.awaitingApprovalAt} >= ${table.createdAt}) AND (${table.approvedAt} IS NULL OR ${table.approvedAt} >= ${table.createdAt}) AND (${table.queuedAt} IS NULL OR ${table.queuedAt} >= ${table.createdAt}) AND (${table.startedAt} IS NULL OR ${table.startedAt} >= ${table.createdAt}) AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt}) AND (${table.failedAt} IS NULL OR ${table.failedAt} >= ${table.createdAt}) AND (${table.rollbackRequiredAt} IS NULL OR ${table.rollbackRequiredAt} >= ${table.createdAt}) AND (${table.rolledBackAt} IS NULL OR ${table.rolledBackAt} >= ${table.createdAt}) AND (${table.cancelledAt} IS NULL OR ${table.cancelledAt} >= ${table.createdAt}) AND (${table.expiredAt} IS NULL OR ${table.expiredAt} >= ${table.createdAt})`,
  ),
  index("skill_architecture_sync_runs_nonterminal_idx")
    .on(table.status, table.statusUpdatedAt, table.updatedAt, table.id),
  index("skill_architecture_sync_runs_target_history_idx").on(table.targetId, table.createdAt, table.id),
  index("skill_architecture_sync_runs_architecture_history_idx").on(table.architectureId, table.createdAt, table.id),
  index("skill_architecture_sync_runs_revision_history_idx").on(table.revisionId, table.createdAt, table.id),
  unique("skill_architecture_sync_runs_id_target_generation_unique").on(table.id, table.targetId, table.targetGeneration),
  unique("skill_architecture_sync_runs_id_generation_unique").on(table.id, table.targetGeneration),
  unique("skill_architecture_sync_runs_actor_request_unique").on(table.actorUserId, table.requestKey),
  unique("skill_architecture_sync_runs_target_idempotency_unique").on(table.targetId, table.idempotencyKey),
]);

export const skillArchitectureSyncSteps = pgTable("skill_architecture_sync_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  schemaVersion: integer("schema_version").notNull().default(1),
  runId: uuid("run_id").notNull().references(() => skillArchitectureSyncRuns.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  action: architectureSyncStepAction("action").notNull(),
  nodeId: text("node_id").notNull(),
  targetGeneration: integer("target_generation").notNull(),
  status: architectureSyncStepStatus("status").notNull().default("planned"),
  idempotencyKey: text("idempotency_key").notNull(),
  desiredDigest: text("desired_digest").notNull(),
  compiledDigest: text("compiled_digest").notNull(),
  observedDigest: text("observed_digest").notNull(),
  planDigest: text("plan_digest").notNull(),
  stepDigest: text("step_digest").notNull(),
  resultDigest: text("result_digest"),
  failureClass: architectureSyncFailureClass("failure_class"),
  failureCode: text("failure_code"),
  statusUpdatedAt: timestamp("status_updated_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    name: "skill_architecture_sync_steps_run_generation_fk",
    columns: [table.runId, table.targetGeneration],
    foreignColumns: [skillArchitectureSyncRuns.id, skillArchitectureSyncRuns.targetGeneration],
  }),
  check("skill_architecture_sync_steps_schema_version_check", sql`${table.schemaVersion} = 1`),
  check("skill_architecture_sync_steps_ordinal_check", sql`${table.ordinal} BETWEEN 1 AND 1000000`),
  check("skill_architecture_sync_steps_node_id_check", sql`${table.nodeId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`),
  check("skill_architecture_sync_steps_generation_check", sql`${table.targetGeneration} BETWEEN 1 AND 1000000000`),
  check("skill_architecture_sync_steps_idempotency_key_check", sql`${table.idempotencyKey} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`),
  check(
    "skill_architecture_sync_steps_digest_check",
    sql`${table.desiredDigest} ~ '^[0-9a-f]{64}$' AND ${table.compiledDigest} ~ '^[0-9a-f]{64}$' AND ${table.observedDigest} ~ '^[0-9a-f]{64}$' AND ${table.planDigest} ~ '^[0-9a-f]{64}$' AND ${table.stepDigest} ~ '^[0-9a-f]{64}$' AND (${table.resultDigest} IS NULL OR ${table.resultDigest} ~ '^[0-9a-f]{64}$')`,
  ),
  check("skill_architecture_sync_steps_failure_pair_check", sql`(${table.failureClass} IS NULL) = (${table.failureCode} IS NULL)`),
  check("skill_architecture_sync_steps_failure_code_check", sql`${table.failureCode} IS NULL OR ${table.failureCode} ~ '^[a-z][a-z0-9._:-]{0,95}$'`),
  check("skill_architecture_sync_steps_metadata_check", sql`architecture_sync_metadata_is_safe(${table.metadata})`),
  check("skill_architecture_sync_steps_timestamps_check", sql`${table.statusUpdatedAt} >= ${table.createdAt} AND (${table.startedAt} IS NULL OR ${table.startedAt} >= ${table.createdAt}) AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt}) AND ${table.updatedAt} >= ${table.createdAt}`),
  index("skill_architecture_sync_steps_nonterminal_idx").on(table.runId, table.status, table.statusUpdatedAt, table.ordinal),
  index("skill_architecture_sync_steps_run_order_idx").on(table.runId, table.ordinal),
  unique("skill_architecture_sync_steps_run_id_unique").on(table.runId, table.id),
  unique("skill_architecture_sync_steps_run_ordinal_unique").on(table.runId, table.ordinal),
  unique("skill_architecture_sync_steps_run_idempotency_unique").on(table.runId, table.idempotencyKey),
]);

export const skillArchitectureSyncTargetLeases = pgTable("skill_architecture_sync_target_leases", {
  id: uuid("id").primaryKey().defaultRandom(),
  schemaVersion: integer("schema_version").notNull().default(1),
  targetId: uuid("target_id").notNull(),
  runId: uuid("run_id").notNull(),
  targetGeneration: integer("target_generation").notNull(),
  holderId: text("holder_id").notNull(),
  fencingToken: bigint("fencing_token", { mode: "number" }).notNull(),
  status: architectureSyncLeaseStatus("status").notNull().default("active"),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    name: "skill_architecture_sync_target_leases_target_fk",
    columns: [table.targetId],
    foreignColumns: [skillArchitectureTargets.id],
  }),
  foreignKey({
    name: "skill_architecture_sync_target_leases_run_fk",
    columns: [table.runId, table.targetId, table.targetGeneration],
    foreignColumns: [skillArchitectureSyncRuns.id, skillArchitectureSyncRuns.targetId, skillArchitectureSyncRuns.targetGeneration],
  }),
  check("skill_architecture_sync_target_leases_schema_version_check", sql`${table.schemaVersion} = 1`),
  check("skill_architecture_sync_target_leases_holder_id_check", sql`${table.holderId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`),
  check("skill_architecture_sync_target_leases_generation_check", sql`${table.targetGeneration} BETWEEN 1 AND 1000000000`),
  check("skill_architecture_sync_target_leases_fencing_token_check", sql`${table.fencingToken} BETWEEN 1 AND 1000000000000`),
  check("skill_architecture_sync_target_leases_expiry_check", sql`${table.expiresAt} > ${table.acquiredAt}`),
  check("skill_architecture_sync_target_leases_released_at_check", sql`${table.status} = 'active' OR ${table.releasedAt} IS NOT NULL`),
  check("skill_architecture_sync_target_leases_metadata_check", sql`architecture_sync_metadata_is_safe(${table.metadata})`),
  check("skill_architecture_sync_target_leases_timestamps_check", sql`${table.updatedAt} >= ${table.createdAt} AND ${table.acquiredAt} >= ${table.createdAt}`),
  index("skill_architecture_sync_target_leases_expiry_idx").on(table.status, table.expiresAt, table.targetId),
  index("skill_architecture_sync_target_leases_run_idx").on(table.runId, table.fencingToken),
  unique("skill_architecture_sync_target_leases_target_id_key").on(table.targetId),
]);

export const skillArchitectureSyncBaselines = pgTable("skill_architecture_sync_baselines", {
  id: uuid("id").primaryKey().defaultRandom(),
  schemaVersion: integer("schema_version").notNull().default(1),
  runId: uuid("run_id").notNull(),
  targetId: uuid("target_id").notNull(),
  targetGeneration: integer("target_generation").notNull(),
  observedDigest: text("observed_digest").notNull(),
  baselineDigest: text("baseline_digest").notNull(),
  restorable: boolean("restorable").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    name: "skill_architecture_sync_baselines_run_fk",
    columns: [table.runId, table.targetId, table.targetGeneration],
    foreignColumns: [skillArchitectureSyncRuns.id, skillArchitectureSyncRuns.targetId, skillArchitectureSyncRuns.targetGeneration],
  }),
  check("skill_architecture_sync_baselines_schema_version_check", sql`${table.schemaVersion} = 1`),
  check("skill_architecture_sync_baselines_generation_check", sql`${table.targetGeneration} BETWEEN 1 AND 1000000000`),
  check("skill_architecture_sync_baselines_digest_check", sql`${table.observedDigest} ~ '^[0-9a-f]{64}$' AND ${table.baselineDigest} ~ '^[0-9a-f]{64}$'`),
  check("skill_architecture_sync_baselines_metadata_check", sql`architecture_sync_metadata_is_safe(${table.metadata})`),
  check("skill_architecture_sync_baselines_captured_at_check", sql`${table.capturedAt} >= ${table.createdAt}`),
  index("skill_architecture_sync_baselines_target_history_idx").on(table.targetId, table.capturedAt, table.id),
  unique("skill_architecture_sync_baselines_run_unique").on(table.runId),
  unique("skill_architecture_sync_baselines_run_id_unique").on(table.runId, table.id),
]);

export const skillArchitectureSyncReceipts = pgTable("skill_architecture_sync_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  schemaVersion: integer("schema_version").notNull().default(1),
  runId: uuid("run_id").notNull(),
  stepId: uuid("step_id"),
  targetId: uuid("target_id").notNull(),
  targetGeneration: integer("target_generation").notNull(),
  fencingToken: bigint("fencing_token", { mode: "number" }),
  kind: architectureSyncReceiptKind("kind").notNull(),
  status: architectureSyncReceiptStatus("status").notNull(),
  code: text("code").notNull(),
  evidenceDigest: text("evidence_digest"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  message: text("message"),
  metadata: jsonb("metadata").notNull().default({}),
}, (table) => [
  foreignKey({
    name: "skill_architecture_sync_receipts_run_fk",
    columns: [table.runId, table.targetId, table.targetGeneration],
    foreignColumns: [skillArchitectureSyncRuns.id, skillArchitectureSyncRuns.targetId, skillArchitectureSyncRuns.targetGeneration],
  }),
  foreignKey({
    name: "skill_architecture_sync_receipts_step_fk",
    columns: [table.runId, table.stepId],
    foreignColumns: [skillArchitectureSyncSteps.runId, skillArchitectureSyncSteps.id],
  }),
  check("skill_architecture_sync_receipts_schema_version_check", sql`${table.schemaVersion} = 1`),
  check("skill_architecture_sync_receipts_generation_check", sql`${table.targetGeneration} BETWEEN 1 AND 1000000000`),
  check("skill_architecture_sync_receipts_fencing_token_check", sql`${table.fencingToken} IS NULL OR ${table.fencingToken} BETWEEN 1 AND 1000000000000`),
  check("skill_architecture_sync_receipts_fencing_requirement_check", sql`${table.kind} IN ('run', 'step', 'approval', 'baseline') OR ${table.fencingToken} IS NOT NULL`),
  check("skill_architecture_sync_receipts_recovery_code_check", sql`${table.kind} <> 'recovery' OR ${table.code} IN ('recovery.retry', 'recovery.succeed', 'recovery.rollback', 'recovery.block', 'recovery.manual')`),
  check("skill_architecture_sync_receipts_code_check", sql`${table.code} ~ '^[a-z][a-z0-9._:-]{0,95}$'`),
  check("skill_architecture_sync_receipts_digest_check", sql`${table.evidenceDigest} IS NULL OR ${table.evidenceDigest} ~ '^[0-9a-f]{64}$'`),
  check("skill_architecture_sync_receipts_recovery_digest_check", sql`${table.kind} <> 'recovery' OR ${table.evidenceDigest} IS NOT NULL`),
  check(
    "skill_architecture_sync_receipts_message_check",
    sql`${table.message} IS NULL OR (length(${table.message}) BETWEEN 1 AND 512 AND ${table.message} !~ '[[:cntrl:]]' AND ${table.message} !~* '(https?://|ftp://|file://|-----BEGIN [A-Z ]+-----|(^|[[:space:] (])/(Users|home|root|private|var|tmp|etc|opt|workspace)([/[:space:] )]|$)|(^|[[:space:]])(bearer|basic)[[:space:]]+[A-Za-z0-9._~+/-]{8,}|(api[_-]?key|authorization|credential|password|private[-_ ]?key|secret|token)[[:space:]]*[:=])'`),
  check("skill_architecture_sync_receipts_metadata_check", sql`architecture_sync_metadata_is_safe(${table.metadata})`),
  index("skill_architecture_sync_receipts_run_history_idx").on(table.runId, table.recordedAt, table.id),
  index("skill_architecture_sync_receipts_target_history_idx").on(table.targetId, table.recordedAt, table.id),
]);

export const skillArchitectureSyncRecoveryEvidence = pgTable("skill_architecture_sync_recovery_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  schemaVersion: integer("schema_version").notNull().default(1),
  runId: uuid("run_id").notNull(),
  targetId: uuid("target_id").notNull(),
  targetGeneration: integer("target_generation").notNull(),
  fencingToken: bigint("fencing_token", { mode: "number" }),
  condition: architectureSyncRecoveryCondition("condition").notNull(),
  decision: architectureSyncRecoveryDecision("decision").notNull(),
  nextRunState: architectureSyncRunStatus("next_run_state").notNull(),
  safeToRetry: boolean("safe_to_retry").notNull(),
  requiresManualReview: boolean("requires_manual_review").notNull(),
  code: text("code").notNull(),
  evidenceDigest: text("evidence_digest").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata").notNull().default({}),
}, (table) => [
  foreignKey({
    name: "skill_architecture_sync_recovery_evidence_run_fk",
    columns: [table.runId, table.targetId, table.targetGeneration],
    foreignColumns: [skillArchitectureSyncRuns.id, skillArchitectureSyncRuns.targetId, skillArchitectureSyncRuns.targetGeneration],
  }),
  check("skill_architecture_sync_recovery_evidence_schema_version_check", sql`${table.schemaVersion} = 1`),
  check("skill_architecture_sync_recovery_evidence_generation_check", sql`${table.targetGeneration} BETWEEN 1 AND 1000000000`),
  check("skill_architecture_sync_recovery_evidence_fencing_token_check", sql`${table.fencingToken} IS NULL OR ${table.fencingToken} BETWEEN 1 AND 1000000000000`),
  check("skill_architecture_sync_recovery_evidence_fencing_requirement_check", sql`${table.fencingToken} IS NOT NULL`),
  check(
    "skill_architecture_sync_recovery_evidence_transition_code_check",
    sql`(${table.condition} = 'no-mutation' AND ${table.decision} = 'retry' AND ${table.nextRunState} = 'queued' AND ${table.code} = 'recovery.retry') OR (${table.condition} = 'desired-readback' AND ${table.decision} = 'succeed' AND ${table.nextRunState} = 'succeeded' AND ${table.code} = 'recovery.succeed') OR (${table.condition} = 'restorable-partial-state' AND ${table.decision} = 'rollback' AND ${table.nextRunState} = 'rollback_required' AND ${table.code} = 'recovery.rollback') OR (${table.condition} = 'ambiguous-readback' AND ${table.decision} = 'block' AND ${table.nextRunState} = 'blocked' AND ${table.code} = 'recovery.block') OR (${table.condition} = 'irreversible-unrecoverable' AND ${table.decision} = 'manual-intervention' AND ${table.nextRunState} = 'rollback_failed' AND ${table.code} = 'recovery.manual')`,
  ),
  check("skill_architecture_sync_recovery_evidence_code_check", sql`${table.code} ~ '^[a-z][a-z0-9._:-]{0,95}$'`),
  check("skill_architecture_sync_recovery_evidence_digest_check", sql`${table.evidenceDigest} ~ '^[0-9a-f]{64}$'`),
  check("skill_architecture_sync_recovery_evidence_metadata_check", sql`architecture_sync_metadata_is_safe(${table.metadata})`),
  index("skill_architecture_sync_recovery_evidence_run_history_idx").on(table.runId, table.recordedAt, table.id),
  index("skill_architecture_sync_recovery_evidence_target_history_idx").on(table.targetId, table.recordedAt, table.id),
]);
