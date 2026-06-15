import { sql } from "drizzle-orm";
import {
  integer,
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const userStatus = pgEnum("user_status", ["pending", "active", "disabled", "deleted"]);
export const roleName = pgEnum("role_name", ["owner", "admin", "maintainer", "author", "user"]);
export const registrationMode = pgEnum("registration_mode", ["closed", "request", "open"]);
export const providerType = pgEnum("provider_type", ["oidc", "saml", "cloudflare_access", "github", "google"]);
export const skillLifecycleStatus = pgEnum("skill_lifecycle_status", ["draft", "private", "submitted", "review", "approved", "deprecated", "revoked", "archived"]);
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
]);
export const teamMembershipRole = pgEnum("team_membership_role", ["owner", "member"]);
export const teamInvitationStatus = pgEnum("team_invitation_status", ["pending", "accepted", "revoked"]);

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

export const teams = pgTable("teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
}, (table) => [
  index("teams_created_by_idx").on(table.createdByUserId),
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
  reviewStatus: reviewStatus("review_status").notNull().default("unreviewed"),
  securityStatus: securityStatus("security_status").notNull().default("not-run"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.skillId, table.version)]);

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
});

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
});

export const scanFindings = pgTable("scan_findings", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanRunId: uuid("scan_run_id").notNull().references(() => scanRuns.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  severity: text("severity").notNull(),
  message: text("message").notNull(),
  path: text("path"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
