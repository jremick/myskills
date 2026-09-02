import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { parseSkillManifest, type PackageInputFile } from "@myskills-app/skill-package";
import { AppError } from "@myskills-app/core";
import { createDb, createPgPool } from "../src/db/client.js";
import {
  skillTeamGrants,
  skillUserGrants,
  teamMemberships,
  teams,
  users,
} from "../src/db/schema.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
import { artifactPayloadSha256 } from "../src/submissions/artifact-hash.js";
import { SubmissionService } from "../src/submissions/service.js";
import type { ArtifactObject, ArtifactObjectStorage } from "../src/artifacts/storage.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

test("Postgres registry publishes searchable releases and enforces bundle sharing", {
  timeout: 60_000,
}, async (t) => {
  assert.ok(databaseUrl);
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(async () => {
    await pool.end();
  });

  await resetDatabase(pool);
  await applyMigrations(pool);

  const db = createDb(pool);
  const skillRepository = new PostgresSkillRepository(db);
  const submissionService = new SubmissionService(new PostgresSubmissionStore(db));

  const author = await insertUser(db, "author@example.com", "Author");
  const maintainer = await insertUser(db, "maintainer@example.com", "Maintainer");
  const teamMember = await insertUser(db, "team-member@example.com", "Team Member");
  const explicitUser = await insertUser(db, "explicit-user@example.com", "Explicit User");
  const outsider = await insertUser(db, "outsider@example.com", "Outsider");
  const team = await insertTeam(db, author.id, "Platform");
  const unrelatedTeamId = "00000000-0000-4000-8000-000000000000";
  await db.insert(teamMemberships).values([
    { teamId: team.id, userId: author.id, role: "owner" },
    { teamId: team.id, userId: teamMember.id, role: "member" },
  ]);

  const packageInput = cleanPackageInput();
  const submitted = await submissionService.createSubmission({
    actor: { id: author.id, roles: ["author"] },
    ...packageInput,
  });
  assert.equal(submitted.reviewStatus, "unreviewed");
  assert.equal(submitted.securityStatus, "passed");

  const reviewBundle = await submissionService.getReviewSubmissionBundle({
    actor: { id: maintainer.id, roles: ["maintainer"] },
    submissionId: submitted.id,
    platform: "codex",
  });
  assert.equal(reviewBundle?.artifact.sha256, submitted.artifact.sha256);
  await assert.rejects(
    submissionService.performReviewAction({
      actor: { id: maintainer.id, roles: ["maintainer"] },
      submissionId: submitted.id,
      action: "approve",
      artifactSha256: "0".repeat(64),
    }),
    (error) => error instanceof AppError && error.code === "ARTIFACT_HASH_MISMATCH",
  );

  const approved = await submissionService.performReviewAction({
    actor: { id: maintainer.id, roles: ["maintainer"] },
    submissionId: submitted.id,
    action: "approve",
    artifactSha256: reviewBundle?.artifact.sha256 ?? submitted.artifact.sha256,
    reason: "integration confidence",
  });
  assert.equal(approved.reviewStatus, "approved");

  const published = await submissionService.performReviewAction({
    actor: { id: maintainer.id, roles: ["maintainer"] },
    submissionId: submitted.id,
    action: "publish",
    reason: "integration confidence",
  });
  assert.equal(published.lifecycleStatus, "approved");
  assert.ok(published.publishedAt);

  const publicSearch = await skillRepository.searchVisibleSkills({ query: "workflow" });
  assert.deepEqual(publicSearch.map((skill) => skill.slug), ["workflow-helper"]);
  assert.deepEqual(publicSearch[0].tags, ["automation", "workflow"]);
  assert.equal(
    (await skillRepository.getSkillVisibleToTeamBySlug("workflow-helper", unrelatedTeamId))?.slug,
    "workflow-helper",
  );

  const publicBundle = await submissionService.getPublicBundle({
    slug: "workflow-helper",
    version: "0.1.0",
    platform: "codex",
  });
  assert.equal(publicBundle?.artifact.contentType, "application/vnd.myskills-app.package+json");
  assert.deepEqual(publicBundle.payload.files.map((file) => file.path).sort(), ["README.md", "skill.json"]);

  const missingPlatform = await submissionService.getPublicBundle({
    slug: "workflow-helper",
    version: "0.1.0",
    platform: "missing",
  });
  assert.equal(missingPlatform, null);

  const teamSharing = await skillRepository.updateSkillSharing({
    actor: { id: author.id, roles: ["author"] },
    slug: "workflow-helper",
    visibility: "team",
    teamIds: [team.id],
    userEmails: [],
  });
  assert.equal(teamSharing.visibility, "team");
  assert.deepEqual(teamSharing.teamGrants.map((grant) => grant.name), ["Platform"]);
  assert.equal(
    (await skillRepository.getSkillVisibleToTeamBySlug("workflow-helper", team.id))?.slug,
    "workflow-helper",
  );
  assert.equal(await skillRepository.getSkillVisibleToTeamBySlug("workflow-helper", unrelatedTeamId), null);

  const anonymousAfterTeamSharing = await skillRepository.searchVisibleSkills({ query: "workflow" });
  assert.deepEqual(anonymousAfterTeamSharing, []);

  const teamSearch = await skillRepository.searchVisibleSkills({
    query: "workflow",
    actorId: teamMember.id,
  });
  assert.equal(teamSearch.length, 1);
  assert.deepEqual(teamSearch[0].access?.reasons, ["team"]);
  assert.equal(teamSearch[0].access?.canManageSharing, false);

  const outsiderSearch = await skillRepository.searchVisibleSkills({
    query: "workflow",
    actorId: outsider.id,
  });
  assert.deepEqual(outsiderSearch, []);

  const anonymousTeamBundle = await submissionService.getPublicBundle({
    slug: "workflow-helper",
    version: "0.1.0",
    platform: "codex",
  });
  assert.equal(anonymousTeamBundle, null);

  const teamBundle = await submissionService.getPublicBundle({
    slug: "workflow-helper",
    version: "0.1.0",
    platform: "codex",
    actorId: teamMember.id,
  });
  assert.equal(teamBundle?.slug, "workflow-helper");

  const explicitSharing = await skillRepository.updateSkillSharing({
    actor: { id: author.id, roles: ["author"] },
    slug: "workflow-helper",
    visibility: "explicit-users",
    teamIds: [],
    userEmails: ["Explicit-User@Example.com"],
  });
  assert.equal(explicitSharing.visibility, "explicit-users");
  assert.deepEqual(explicitSharing.userGrants.map((grant) => grant.email), ["explicit-user@example.com"]);
  assert.equal(await skillRepository.getSkillVisibleToTeamBySlug("workflow-helper", team.id), null);

  const explicitSearch = await skillRepository.searchVisibleSkills({
    query: "workflow",
    actorId: explicitUser.id,
  });
  assert.deepEqual(explicitSearch[0].access?.reasons, ["explicit-user"]);

  const staleTeamSearch = await skillRepository.searchVisibleSkills({
    query: "workflow",
    actorId: teamMember.id,
  });
  assert.deepEqual(staleTeamSearch, []);

  const grantCounts = await Promise.all([
    db.select().from(skillTeamGrants),
    db.select().from(skillUserGrants),
  ]);
  assert.equal(grantCounts[0].length, 0);
  assert.equal(grantCounts[1].length, 1);
});

test("approval artifact hash migration backfills legacy approved unpublished rows", {
  timeout: 60_000,
}, async (t) => {
  assert.ok(databaseUrl);
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(async () => {
    await pool.end();
  });

  await resetDatabase(pool);
  await applyMigrations(pool, { before: "0012_approval_artifact_hash" });

  const packageInput = cleanPackageInput();
  const payload = { files: packageInput.files };
  const payloadText = JSON.stringify(payload);
  const artifactSha256 = artifactPayloadSha256(payload);
  const skill = await pool.query<{ id: string }>(`
    INSERT INTO skills (slug, title, summary, visibility, lifecycle_status, owner_user_id)
    VALUES ('workflow-helper', 'Workflow Helper', 'Coordinates repeatable release workflows.', 'public', 'submitted', NULL)
    RETURNING id
  `);
  const version = await pool.query<{ id: string }>(`
    INSERT INTO skill_versions (skill_id, version, review_status, security_status, lifecycle_status, lifecycle_updated_at)
    VALUES ($1, '0.1.0', 'approved', 'passed', 'review', now())
    RETURNING id
  `, [skill.rows[0].id]);
  await pool.query(`
    INSERT INTO skill_platform_variants (skill_version_id, name, install_target, status)
    VALUES ($1, 'codex', 'codex-skill', 'supported')
  `, [version.rows[0].id]);
  await pool.query(`
    INSERT INTO skill_artifacts (skill_version_id, storage_key, sha256, byte_size, content_type, payload)
    VALUES ($1, 'legacy/workflow-helper.json', $2, $3, 'application/vnd.myskills-app.package+json', $4::jsonb)
  `, [version.rows[0].id, artifactSha256, Buffer.byteLength(payloadText), payloadText]);
  await pool.query(`
    INSERT INTO scan_runs (skill_version_id, status, started_at, completed_at)
    VALUES ($1, 'succeeded', now(), now())
  `, [version.rows[0].id]);

  await applyMigration(pool, "0012_approval_artifact_hash");

  const backfilled = await pool.query<{ approved_artifact_sha256: string | null }>(
    "SELECT approved_artifact_sha256 FROM skill_versions WHERE id = $1",
    [version.rows[0].id],
  );
  assert.equal(backfilled.rows[0].approved_artifact_sha256, artifactSha256);

  // The store uses the current schema projection. Add the later release
  // metadata columns after proving the isolated 0012 backfill behavior.
  await applyMigration(pool, "0021_skill_release_metadata");

  const db = createDb(pool);
  const maintainer = await insertUser(db, "legacy-maintainer@example.com", "Legacy Maintainer");
  const submissionService = new SubmissionService(new PostgresSubmissionStore(db));
  const published = await submissionService.performReviewAction({
    actor: { id: maintainer.id, roles: ["maintainer"] },
    submissionId: version.rows[0].id,
    action: "publish",
  });
  assert.equal(published.lifecycleStatus, "approved");
  assert.ok(published.publishedAt);
});

test("Postgres review publish rejects deleted approved unpublished releases", {
  timeout: 60_000,
}, async (t) => {
  assert.ok(databaseUrl);
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(async () => {
    await pool.end();
  });

  await resetDatabase(pool);
  await applyMigrations(pool);

  const db = createDb(pool);
  const submissionService = new SubmissionService(new PostgresSubmissionStore(db));
  const author = await insertUser(db, "author@example.com", "Author");
  const maintainer = await insertUser(db, "maintainer@example.com", "Maintainer");
  const maintainerActor = { id: maintainer.id, roles: ["maintainer" as const] };

  const submitted = await submissionService.createSubmission({
    actor: { id: author.id, roles: ["author"] },
    ...cleanPackageInput(),
  });
  const reviewBundle = await submissionService.getReviewSubmissionBundle({
    actor: maintainerActor,
    submissionId: submitted.id,
    platform: "codex",
  });
  await submissionService.performReviewAction({
    actor: maintainerActor,
    submissionId: submitted.id,
    action: "approve",
    artifactSha256: reviewBundle?.artifact.sha256 ?? submitted.artifact.sha256,
  });

  const deleted = await submissionService.performReleaseAction({
    actor: maintainerActor,
    slug: "workflow-helper",
    version: "0.1.0",
    action: "delete",
    reason: "remove before release",
  });
  assert.equal(deleted.lifecycleStatus, "archived");

  await assert.rejects(
    submissionService.performReviewAction({
      actor: maintainerActor,
      submissionId: submitted.id,
      action: "publish",
    }),
    (error) => error instanceof AppError && error.code === "SUBMISSION_NOT_REVIEWABLE",
  );

  const reviewQueue = await submissionService.listReviewSubmissions(maintainerActor);
  assert.equal(reviewQueue.some((submission) => submission.id === submitted.id), false);
  assert.equal(await submissionService.getPublicRelease({ slug: "workflow-helper", version: "0.1.0" }), null);
});

test("Postgres review approval rejects inactive submissions", {
  timeout: 60_000,
}, async (t) => {
  assert.ok(databaseUrl);
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(async () => {
    await pool.end();
  });

  await resetDatabase(pool);
  await applyMigrations(pool);

  const db = createDb(pool);
  const submissionService = new SubmissionService(new PostgresSubmissionStore(db));
  const author = await insertUser(db, "inactive-author@example.com", "Inactive Author");
  const maintainer = await insertUser(db, "inactive-maintainer@example.com", "Inactive Maintainer");
  const maintainerActor = { id: maintainer.id, roles: ["maintainer" as const] };

  const submitted = await submissionService.createSubmission({
    actor: { id: author.id, roles: ["author"] },
    ...cleanPackageInput(),
  });
  const reviewBundle = await submissionService.getReviewSubmissionBundle({
    actor: maintainerActor,
    submissionId: submitted.id,
    platform: "codex",
  });
  assert.ok(reviewBundle);

  await pool.query(
    "UPDATE skill_versions SET lifecycle_status = 'archived', deleted_at = now() WHERE id = $1",
    [submitted.id],
  );

  await assert.rejects(
    submissionService.performReviewAction({
      actor: maintainerActor,
      submissionId: submitted.id,
      action: "approve",
      artifactSha256: reviewBundle.artifact.sha256,
    }),
    (error) => error instanceof AppError && error.code === "SUBMISSION_NOT_REVIEWABLE",
  );

  await assert.rejects(
    submissionService.performReviewAction({
      actor: maintainerActor,
      submissionId: submitted.id,
      action: "request-changes",
    }),
    (error) => error instanceof AppError && error.code === "SUBMISSION_NOT_REVIEWABLE",
  );
  const denyAudit = await pool.query<{ count: string }>(`
    SELECT count(*)::text
    FROM audit_events
    WHERE action = 'review.request_changes'
      AND decision = 'deny'
      AND resource_id = $1
      AND details->>'reason' = 'not_reviewable'
  `, [submitted.id]);
  assert.equal(denyAudit.rows[0].count, "1");

  const reviewQueue = await submissionService.listReviewSubmissions(maintainerActor);
  assert.equal(reviewQueue.some((submission) => submission.id === submitted.id), false);
});

test("Postgres review approval rejects archived skills", {
  timeout: 60_000,
}, async (t) => {
  assert.ok(databaseUrl);
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(async () => {
    await pool.end();
  });

  await resetDatabase(pool);
  await applyMigrations(pool);

  const db = createDb(pool);
  const submissionService = new SubmissionService(new PostgresSubmissionStore(db));
  const author = await insertUser(db, "archived-author@example.com", "Archived Author");
  const maintainer = await insertUser(db, "archived-maintainer@example.com", "Archived Maintainer");
  const maintainerActor = { id: maintainer.id, roles: ["maintainer" as const] };

  const submitted = await submissionService.createSubmission({
    actor: { id: author.id, roles: ["author"] },
    ...cleanPackageInput(),
  });
  const reviewBundle = await submissionService.getReviewSubmissionBundle({
    actor: maintainerActor,
    submissionId: submitted.id,
    platform: "codex",
  });
  assert.ok(reviewBundle);

  await pool.query("UPDATE skills SET lifecycle_status = 'archived' WHERE slug = $1", ["workflow-helper"]);

  await assert.rejects(
    submissionService.performReviewAction({
      actor: maintainerActor,
      submissionId: submitted.id,
      action: "approve",
      artifactSha256: reviewBundle.artifact.sha256,
    }),
    (error) => error instanceof AppError && error.code === "SUBMISSION_NOT_REVIEWABLE",
  );

  const reviewQueue = await submissionService.listReviewSubmissions(maintainerActor);
  assert.equal(reviewQueue.some((submission) => submission.id === submitted.id), false);
});

test("Postgres publish fails when artifact payload changes after approval", {
  timeout: 60_000,
}, async (t) => {
  assert.ok(databaseUrl);
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(async () => {
    await pool.end();
  });

  await resetDatabase(pool);
  await applyMigrations(pool);

  const db = createDb(pool);
  const submissionService = new SubmissionService(new PostgresSubmissionStore(db));
  const author = await insertUser(db, "mutating-author@example.com", "Mutating Author");
  const maintainer = await insertUser(db, "mutating-maintainer@example.com", "Mutating Maintainer");
  const maintainerActor = { id: maintainer.id, roles: ["maintainer" as const] };

  const submitted = await submissionService.createSubmission({
    actor: { id: author.id, roles: ["author"] },
    ...cleanPackageInput(),
  });
  const reviewBundle = await submissionService.getReviewSubmissionBundle({
    actor: maintainerActor,
    submissionId: submitted.id,
    platform: "codex",
  });
  assert.ok(reviewBundle);
  await submissionService.performReviewAction({
    actor: maintainerActor,
    submissionId: submitted.id,
    action: "approve",
    artifactSha256: reviewBundle.artifact.sha256,
  });

  await pool.query(`
    UPDATE skill_artifacts
    SET payload = jsonb_set(payload, '{files,1,content}', to_jsonb('Changed after approval.'::text))
    WHERE skill_version_id = $1
  `, [submitted.id]);

  await assert.rejects(
    submissionService.performReviewAction({
      actor: maintainerActor,
      submissionId: submitted.id,
      action: "publish",
    }),
    (error) => error instanceof AppError && error.code === "APPROVED_ARTIFACT_HASH_MISMATCH",
  );
});

test("Postgres publish rejects artifact payload mutation between pre-read and revalidation", {
  timeout: 60_000,
}, async (t) => {
  assert.ok(databaseUrl);
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(async () => {
    await pool.end();
  });

  await resetDatabase(pool);
  await applyMigrations(pool);

  const db = createDb(pool);
  const artifactStorage = new MutatingArtifactStorage();
  const submissionService = new SubmissionService(new PostgresSubmissionStore(db, { artifactStorage }));
  const author = await insertUser(db, "window-author@example.com", "Window Author");
  const maintainer = await insertUser(db, "window-maintainer@example.com", "Window Maintainer");
  const maintainerActor = { id: maintainer.id, roles: ["maintainer" as const] };

  const submitted = await submissionService.createSubmission({
    actor: { id: author.id, roles: ["author"] },
    ...cleanPackageInput(),
  });
  const reviewBundle = await submissionService.getReviewSubmissionBundle({
    actor: maintainerActor,
    submissionId: submitted.id,
    platform: "codex",
  });
  assert.ok(reviewBundle);
  await submissionService.performReviewAction({
    actor: maintainerActor,
    submissionId: submitted.id,
    action: "approve",
    artifactSha256: reviewBundle.artifact.sha256,
  });

  artifactStorage.mutateOnNextGet = async () => {
    await pool.query(`
      UPDATE skill_artifacts
      SET payload = '{"files":[{"path":"tampered.txt","content":"Changed during publish."}]}'::jsonb
      WHERE skill_version_id = $1
    `, [submitted.id]);
  };

  await assert.rejects(
    submissionService.performReviewAction({
      actor: maintainerActor,
      submissionId: submitted.id,
      action: "publish",
    }),
    (error) => error instanceof AppError && error.code === "APPROVED_ARTIFACT_HASH_MISMATCH",
  );
});

function cleanPackageInput(): {
  manifest: ReturnType<typeof parseSkillManifest>;
  files: PackageInputFile[];
} {
  const manifest = parseSkillManifest({
    name: "workflow-helper",
    title: "Workflow Helper",
    summary: "Coordinates repeatable release workflows.",
    version: "0.1.0",
    license: "Apache-2.0",
    visibility: "public",
    platforms: [{ name: "codex", install_target: "codex-skill" }],
    tags: ["workflow", "automation"],
  });

  return {
    manifest,
    files: [
      {
        path: "skill.json",
        content: JSON.stringify(manifest),
      },
      {
        path: "README.md",
        content: "Coordinate repeatable release workflows.",
      },
    ],
  };
}

class MutatingArtifactStorage implements ArtifactObjectStorage {
  mutateOnNextGet: (() => Promise<void>) | null = null;
  private readonly objects = new Map<string, ArtifactObject>();

  async putObject(input: { key: string; body: string; contentType: string; sha256: string }): Promise<void> {
    if (this.objects.has(input.key)) {
      throw new Error("Artifact object already exists.");
    }
    this.objects.set(input.key, {
      body: input.body,
      contentType: input.contentType,
      sha256: input.sha256,
    });
  }

  async getObject(key: string): Promise<ArtifactObject> {
    const object = this.objects.get(key);
    if (!object) {
      throw new Error("Artifact object not found.");
    }
    const mutate = this.mutateOnNextGet;
    this.mutateOnNextGet = null;
    if (mutate) {
      await mutate();
    }
    return object;
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async checkReady(): Promise<void> {}
}

async function insertUser(db: ReturnType<typeof createDb>, email: string, name: string) {
  const normalizedEmail = email.toLowerCase();
  const [user] = await db
    .insert(users)
    .values({
      email: normalizedEmail,
      normalizedEmail,
      name,
      status: "active",
      emailVerifiedAt: new Date(),
    })
    .returning({ id: users.id, email: users.email });
  assert.ok(user);
  return user;
}

async function insertTeam(db: ReturnType<typeof createDb>, createdByUserId: string, name: string) {
  const [team] = await db
    .insert(teams)
    .values({
      name,
      slug: name.toLowerCase(),
      createdByUserId,
    })
    .returning({ id: teams.id, name: teams.name });
  assert.ok(team);
  return team;
}

function assertSafeTestDatabaseUrl(value: string): void {
  const databaseName = new URL(value).pathname.replace(/^\//, "");
  if (!/(^|[_-])(test|ci)([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to reset non-test database ${databaseName}. Use TEST_DATABASE_URL with a test database.`);
  }
}

async function resetDatabase(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

async function applyMigrations(pool: ReturnType<typeof createPgPool>, options: { before?: string } = {}): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (options.before && file.replace(/\.sql$/, "") >= options.before) {
      continue;
    }
    await applyMigration(pool, file.replace(/\.sql$/, ""));
  }
}

async function applyMigration(pool: ReturnType<typeof createPgPool>, id: string): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const file = id.endsWith(".sql") ? id : `${id}.sql`;
  const migrationId = file.replace(/\.sql$/, "");
  const existing = await pool.query("SELECT id FROM schema_migrations WHERE id = $1", [migrationId]);
  if (existing.rowCount) {
    return;
  }

  const sql = readFileSync(join(migrationsDir, file), "utf8");
  await pool.query("BEGIN");
  try {
    await pool.query(sql);
    await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migrationId]);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}
