import { sql } from "drizzle-orm";
import {
  integer,
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
export const skillLifecycleStatus = pgEnum("skill_lifecycle_status", ["draft", "private", "submitted", "review", "approved", "deprecated", "revoked", "archived"]);
export const visibilityScope = pgEnum("visibility_scope", ["public", "authenticated", "organization", "team", "private", "explicit-users"]);
export const reviewStatus = pgEnum("review_status", ["unreviewed", "changes-requested", "approved", "rejected"]);
export const securityStatus = pgEnum("security_status", ["not-run", "passed", "warning", "failed"]);
export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "failed"]);

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
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
