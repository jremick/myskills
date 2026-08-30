import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { hashPassword } from "@myskills-app/auth";
import {
  AppError,
  architecturePatternIds,
  type ArchitecturePatternId,
  type ArchitectureSpecV1,
} from "@myskills-app/core";
import { buildApp } from "../src/app.js";
import { PostgresArchitectureStore } from "../src/architectures/postgres-store.js";
import { ARCHITECTURE_PATTERNS } from "../src/architectures/service.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { createDb, createPgPool, type Database } from "../src/db/client.js";
import { skillArchitectureRevisions, skillArchitectures, users } from "../src/db/schema.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import type { SubmissionService } from "../src/submissions/service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
const password = "correct horse battery staple";

const ownerId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";

test("migration 0015 persists every advertised architecture pattern id", { timeout: 60_000 }, async (t) => {
  const testDatabaseUrl = requiredTestDatabaseUrl();
  const pool = createPgPool(testDatabaseUrl);
  t.after(() => pool.end());
  await resetAndApplyThrough0015(pool);

  const db = createDb(pool);
  const store = new PostgresArchitectureStore(db);
  await insertUser(db, ownerId, "architect-owner@example.com");

  assert.deepEqual(ARCHITECTURE_PATTERNS.map((pattern) => pattern.id), [...architecturePatternIds]);

  for (const patternId of architecturePatternIds) {
    const architecture = await store.createArchitecture({
      ownerUserId: ownerId,
      name: `${patternId} architecture`,
      description: "Pattern persistence check.",
      patternId,
    });
    const revision = await store.createRevision({
      ownerUserId: ownerId,
      architectureId: architecture.id,
      message: "Initial revision",
      spec: architectureSpec(patternId, architecture.id),
    });
    assert.equal(revision?.spec.pattern.id, patternId);
  }

  const rows = await db
    .select({ patternId: skillArchitectures.patternId })
    .from(skillArchitectures)
    .orderBy(skillArchitectures.patternId);
  assert.deepEqual(rows.map((row) => row.patternId).sort(), [...architecturePatternIds].sort());

  await assert.rejects(
    pool.query(
      "insert into skill_architectures (owner_user_id, name, description, pattern_id) values ($1, $2, $3, $4)",
      [ownerId, "Unsupported", "", "router-tree"],
    ),
    (error) => isConstraintError(error, "skill_architectures_pattern_id_check"),
  );
});

test("postgres architecture revisions are sequential, immutable records with a current revision pointer", { timeout: 60_000 }, async (t) => {
  const testDatabaseUrl = requiredTestDatabaseUrl();
  const pool = createPgPool(testDatabaseUrl);
  t.after(() => pool.end());
  await resetAndApplyThrough0015(pool);

  const db = createDb(pool);
  const store = new PostgresArchitectureStore(db);
  await insertUser(db, ownerId, "revision-owner@example.com");
  const architecture = await store.createArchitecture({
    ownerUserId: ownerId,
    name: "Sequential revisions",
    description: "",
    patternId: "multi-level-router",
  });

  const firstSpec = architectureSpec("multi-level-router", architecture.id);
  const first = await store.createRevision({
    ownerUserId: ownerId,
    architectureId: architecture.id,
    message: "Initial topology",
    spec: firstSpec,
  });
  assert.equal(first?.revisionNumber, 1);

  firstSpec.name = "mutated caller copy";
  const second = await store.createRevision({
    ownerUserId: ownerId,
    architectureId: architecture.id,
    message: "Second topology",
    spec: {
      ...architectureSpec("multi-level-router", architecture.id),
      description: "Revision two keeps revision one immutable.",
    },
  });
  assert.equal(second?.revisionNumber, 2);

  const current = await store.getArchitecture(ownerId, architecture.id);
  assert.equal(current?.currentRevisionId, second?.id);
  assert.equal(current?.revisionCount, 2);

  const firstRead = await store.getRevision(ownerId, architecture.id, first?.id);
  assert.equal(firstRead?.revisionNumber, 1);
  assert.equal(firstRead?.spec.name, "multi-level-router architecture");
  assert.equal(firstRead?.spec.description, undefined);

  const latestRead = await store.getRevision(ownerId, architecture.id);
  assert.equal(latestRead?.id, second?.id);
  assert.equal(latestRead?.spec.description, "Revision two keeps revision one immutable.");

  await assert.rejects(
    pool.query(
      "insert into skill_architecture_revisions (architecture_id, revision_number, message, spec, created_by_user_id) values ($1, $2, $3, $4::jsonb, $5)",
      [architecture.id, 2, "duplicate", JSON.stringify(architectureSpec("multi-level-router", architecture.id)), ownerId],
    ),
    // PostgreSQL truncates unnamed constraint identifiers at 63 bytes, so the
    // generated name is not guaranteed to retain the full column name.
    (error) => isUniqueViolation(error),
  );
});

test("postgres architecture records and revisions are isolated by owner", { timeout: 60_000 }, async (t) => {
  const testDatabaseUrl = requiredTestDatabaseUrl();
  const pool = createPgPool(testDatabaseUrl);
  t.after(() => pool.end());
  await resetAndApplyThrough0015(pool);

  const db = createDb(pool);
  const store = new PostgresArchitectureStore(db);
  await insertUser(db, ownerId, "isolation-owner@example.com");
  await insertUser(db, otherUserId, "isolation-other@example.com");

  const architecture = await store.createArchitecture({
    ownerUserId: ownerId,
    name: "Owner private",
    description: "",
    patternId: "domain-router",
  });
  const revision = await store.createRevision({
    ownerUserId: ownerId,
    architectureId: architecture.id,
    message: "Private revision",
    spec: architectureSpec("domain-router", architecture.id),
  });

  assert.equal((await store.listArchitectures(ownerId)).length, 1);
  assert.deepEqual(await store.listArchitectures(otherUserId), []);
  assert.equal(await store.getArchitecture(otherUserId, architecture.id), null);
  assert.equal(await store.listRevisions(otherUserId, architecture.id), null);
  assert.equal(await store.getRevision(otherUserId, architecture.id, revision?.id), null);
  assert.equal(await store.createRevision({
    ownerUserId: otherUserId,
    architectureId: architecture.id,
    message: "Cross-owner write",
    spec: architectureSpec("domain-router", architecture.id),
  }), null);
});

test("postgres architecture write/read paths validate spec shape, pattern, and persisted route identity", { timeout: 60_000 }, async (t) => {
  const testDatabaseUrl = requiredTestDatabaseUrl();
  const pool = createPgPool(testDatabaseUrl);
  t.after(() => pool.end());
  await resetAndApplyThrough0015(pool);

  const db = createDb(pool);
  const store = new PostgresArchitectureStore(db);
  await insertUser(db, ownerId, "validation-owner@example.com");
  const architecture = await store.createArchitecture({
    ownerUserId: ownerId,
    name: "Validation",
    description: "",
    patternId: "multi-level-router",
  });

  await assert.rejects(
    store.createRevision({
      ownerUserId: ownerId,
      architectureId: architecture.id,
      message: "Wrong pattern",
      spec: architectureSpec("flat", architecture.id),
    }),
    (error) => error instanceof AppError && error.code === "ARCHITECTURE_PATTERN_MISMATCH",
  );

  const invalidShape = architectureSpec("multi-level-router", architecture.id);
  invalidShape.edges = [{ from: "root", to: "release-notes", kind: "routes" }];
  await assert.rejects(
    store.createRevision({
      ownerUserId: ownerId,
      architectureId: architecture.id,
      message: "Invalid shape",
      spec: invalidShape,
    }),
    (error) => error instanceof AppError && error.code === "ARCHITECTURE_ORPHAN_NODE",
  );

  const valid = await store.createRevision({
    ownerUserId: ownerId,
    architectureId: architecture.id,
    message: "Valid revision",
    spec: architectureSpec("multi-level-router", architecture.id),
  });
  assert.ok(valid);

  await db
    .update(skillArchitectureRevisions)
    .set({ spec: { ...architectureSpec("multi-level-router", architecture.id), id: "wrong-route-id" } })
    .where(eq(skillArchitectureRevisions.id, valid.id));

  await assert.rejects(
    store.getRevision(ownerId, architecture.id, valid.id),
    (error) => error instanceof AppError
      && error.code === "PERSISTED_ARCHITECTURE_INVALID"
      && error.statusCode === 500,
  );
});

test("postgres-backed architecture routes normalize revision identity to the route architecture id", { timeout: 60_000 }, async (t) => {
  const testDatabaseUrl = requiredTestDatabaseUrl();
  const pool = createPgPool(testDatabaseUrl);
  t.after(() => pool.end());
  await resetAndApplyThrough0015(pool);

  const db = createDb(pool);
  await insertUser(db, ownerId, "route-owner@example.com");
  const architectureStore = new PostgresArchitectureStore(db);
  const authStore = new MemoryAuthStore("closed");
  const app = buildApp({
    skillRepository: architectureSkillRepository(),
    authService: new AuthService(authStore),
    architectureStore,
    submissionService: architectureReleaseResolver(),
  });
  t.after(() => app.close());

  const token = await addMemoryUserAndLogin(app, authStore, {
    id: ownerId,
    email: "route-owner@example.com",
    roles: ["author"],
  });
  const created = await app.inject({
    method: "POST",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Route identity",
      description: "Route id normalization.",
      patternId: "multi-level-router",
    },
  });
  assert.equal(created.statusCode, 201);
  const architectureId = created.json().architecture.id as string;

  const routeSpec = { ...architectureSpec("multi-level-router", "client-supplied-id") };
  const revision = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { message: "Route-owned identity", spec: routeSpec },
  });
  assert.equal(revision.statusCode, 201);
  assert.equal(revision.json().revision.spec.id, architectureId);

  const persisted = await architectureStore.getRevision(ownerId, architectureId, revision.json().revision.id);
  assert.equal(persisted?.spec.id, architectureId);
});

function requiredTestDatabaseUrl(): string {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for Postgres architecture tests.");
  assertSafeTestDatabaseUrl(databaseUrl);
  return databaseUrl;
}

function assertSafeTestDatabaseUrl(value: string): void {
  const parsed = new URL(value);
  const databaseName = parsed.pathname.replace(/^\//, "");
  assert.match(databaseName, /(test|ci)/i, "TEST_DATABASE_URL must target a disposable database whose name includes test or ci.");
}

async function resetAndApplyThrough0015(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await applyMigrations(pool, { before: "0015_skill_architectures" });
  await applyMigration(pool, "0015_skill_architectures");
}

async function applyMigrations(
  pool: ReturnType<typeof createPgPool>,
  options: { before?: string } = {},
): Promise<void> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const migrationFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrationFiles) {
    const id = file.replace(/\.sql$/, "");
    if (options.before && id === options.before) break;
    await applyMigration(pool, id);
  }
}

async function applyMigration(pool: ReturnType<typeof createPgPool>, id: string): Promise<void> {
  const contents = readFileSync(join(migrationsDir, `${id}.sql`), "utf8");
  await pool.query("BEGIN");
  try {
    await pool.query(contents);
    await pool.query("INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [id]);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

async function insertUser(db: Database, id: string, email: string): Promise<void> {
  await db.insert(users).values({
    id,
    email,
    normalizedEmail: email.toLowerCase(),
    name: email.split("@")[0] ?? "",
    status: "active",
    emailVerifiedAt: new Date(),
  });
}

async function addMemoryUserAndLogin(
  app: ReturnType<typeof buildApp>,
  authStore: MemoryAuthStore,
  input: { id: string; email: string; roles: Array<"owner" | "admin" | "maintainer" | "author" | "user"> },
): Promise<string> {
  authStore.addUser({
    id: input.id,
    email: input.email,
    name: input.email.split("@")[0] ?? "",
    status: "active",
    emailVerifiedAt: new Date(),
    roles: input.roles,
    passwordHash: await hashPassword(password),
  });
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: input.email, password },
  });
  assert.equal(login.statusCode, 200);
  return login.json().token;
}

function architectureSpec(patternId: ArchitecturePatternId, id: string): ArchitectureSpecV1 {
  if (patternId === "flat") {
    return {
      schemaVersion: 1,
      id,
      name: "flat architecture",
      pattern: { id: "flat", version: 1 },
      skills: [skillRef()],
      nodes: [{ id: "release-notes", kind: "leaf", label: "Release notes", skillRefId: "release-notes" }],
      edges: [],
      entryNodeIds: ["release-notes"],
      profiles: [profile("personal", "Personal", [{ nodeId: "release-notes", enabled: true, runtimeExposure: "leaf" }])],
      environments: [{ id: "personal-mac", name: "Personal Mac", kind: "personal", profileId: "personal" }],
    };
  }

  if (patternId === "domain-router") {
    return {
      schemaVersion: 1,
      id,
      name: "domain-router architecture",
      pattern: { id: "domain-router", version: 1 },
      skills: [skillRef()],
      nodes: [
        { id: "root", kind: "router", label: "All skills" },
        { id: "release-notes", kind: "leaf", label: "Release notes", skillRefId: "release-notes" },
      ],
      edges: [{ from: "root", to: "release-notes", kind: "routes" }],
      entryNodeIds: ["root"],
      profiles: [profile("personal", "Personal", [
        { nodeId: "root", enabled: true, runtimeExposure: "router" },
        { nodeId: "release-notes", enabled: true, runtimeExposure: "leaf" },
      ])],
      environments: [{ id: "personal-mac", name: "Personal Mac", kind: "personal", profileId: "personal" }],
    };
  }

  return {
    schemaVersion: 1,
    id,
    name: "multi-level-router architecture",
    pattern: { id: "multi-level-router", version: 1 },
    skills: [skillRef()],
    nodes: [
      { id: "root", kind: "router", label: "All skills" },
      { id: "delivery", kind: "router", label: "Delivery" },
      { id: "release-notes", kind: "leaf", label: "Release notes", skillRefId: "release-notes" },
    ],
    edges: [
      { from: "root", to: "delivery", kind: "contains" },
      { from: "delivery", to: "release-notes", kind: "routes" },
    ],
    entryNodeIds: ["root"],
    profiles: [profile("personal", "Personal", [
      { nodeId: "root", enabled: true, runtimeExposure: "router" },
      { nodeId: "delivery", enabled: true, runtimeExposure: "router" },
      { nodeId: "release-notes", enabled: true, runtimeExposure: "leaf" },
    ])],
    environments: [{ id: "personal-mac", name: "Personal Mac", kind: "personal", profileId: "personal" }],
  };
}

function skillRef(): ArchitectureSpecV1["skills"][number] {
  return {
    id: "release-notes",
    slug: "release-notes-helper",
    title: "Release notes",
    version: "1.0.0",
    digest: "a".repeat(64),
    packageVisibility: "private",
  };
}

function profile(
  id: string,
  name: string,
  bindings: ArchitectureSpecV1["profiles"][number]["bindings"],
): ArchitectureSpecV1["profiles"][number] {
  return {
    id,
    name,
    subject: { type: "user", id: ownerId },
    defaultExposure: "disabled",
    bindings,
  };
}

function architectureReleaseResolver(): SubmissionService {
  return {
    async getPublicRelease(input: { slug: string; version: string }) {
      if (input.slug !== "release-notes-helper" || input.version !== "1.0.0") return null;
      return {
        slug: input.slug,
        title: "Release notes",
        summary: "Prepare release notes.",
        version: input.version,
        lifecycleStatus: "approved",
        reviewStatus: "approved",
        securityStatus: "passed",
        publishedAt: "2026-08-30T00:00:00.000Z",
        platforms: [],
        artifact: { sha256: "a".repeat(64), byteSize: 128, contentType: "application/zip" },
      };
    },
  } as unknown as SubmissionService;
}

function architectureSkillRepository(): MemorySkillRepository {
  return new MemorySkillRepository([{
    slug: "release-notes-helper",
    title: "Release notes",
    summary: "Prepare release notes.",
    lifecycleStatus: "approved",
    visibility: "public",
    latestVersion: "1.0.0",
    reviewStatus: "approved",
    securityStatus: "passed",
    platforms: [],
    tags: ["delivery"],
  }]);
}

function isConstraintError(error: unknown, constraint: string): boolean {
  return (typeof error === "object" && error !== null && "constraint" in error && error.constraint === constraint)
    || (error instanceof Error && error.message.includes(constraint));
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
