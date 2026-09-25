import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { auditEvents, skillArtifacts, skills, skillVersions, users } from "../src/db/schema.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { AuthService } from "../src/auth/service.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";
import type { AuthResponseUser } from "../src/auth/types.js";

test("Postgres review and audit cursors retain all tied and sub-millisecond rows", { timeout: 60_000 }, async (t) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl);
  assert.match(new URL(databaseUrl).pathname, /(^|[_/-])(test|ci)([_-]|$)/i, "disposable test database required");
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);
  const db = createDb(pool);
  const [owner] = await db.insert(users).values({ email: "pages@example.com", normalizedEmail: "pages@example.com", name: "Pages", status: "active" }).returning();
  assert.ok(owner);
  const actor: AuthResponseUser = { ...owner, roles: ["owner"], emailVerified: true, mfaVerified: true };
  const [skill] = await db.insert(skills).values({ slug: "page-review", title: "Page review", summary: "Pending review fixtures", ownerUserId: owner.id, lifecycleStatus: "submitted" }).returning();
  assert.ok(skill);
  // Repeated exact timestamps plus two distinct microseconds in one JS millisecond.
  const stamps = Array.from({ length: 123 }, (_, index) => index < 121 ? "2026-09-25T00:00:00.123456Z" : index === 121 ? "2026-09-25T00:00:00.123457Z" : "2026-09-25T00:00:00.123455Z");
  const versions = await db.insert(skillVersions).values(stamps.map((stamp, index) => ({ skillId: skill.id, version: `1.0.${index}`, createdAt: sql`${stamp}::timestamptz` }))).returning({ id: skillVersions.id });
  await db.insert(skillArtifacts).values(versions.map((version) => ({ skillVersionId: version.id, storageKey: `fixture/${version.id}`, sha256: "1".repeat(64), byteSize: 12, contentType: "application/json", payload: { files: [] } })));
  await db.insert(auditEvents).values(stamps.map((stamp, index) => ({ actorUserId: owner.id, action: `fixture.${index}`, decision: "allow", createdAt: sql`${stamp}::timestamptz` })));
  const review = new SubmissionService(new PostgresSubmissionStore(db));
  const audit = new AuthService(new PostgresAuthStore(db));
  for (const kind of ["review", "audit"] as const) {
    const expected = await pool.query<{ id: string }>(kind === "review" ? "SELECT id FROM skill_versions ORDER BY created_at DESC, id DESC" : "SELECT id FROM audit_events ORDER BY created_at DESC, id DESC");
    const seen: string[] = [];
    let cursor: string | undefined;
    let firstCursor = "";
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = kind === "review" ? await review.listReviewSubmissionPage(actor, { limit: 29, cursor }) : await audit.listAdminAuditPage(actor, { limit: 29, cursor });
      const rows = "submissions" in page ? page.submissions : page.events;
      seen.push(...rows.map((row) => row.id));
      cursor = page.nextCursor ?? undefined;
      firstCursor ||= cursor ?? "";
      if (!cursor) break;
    }
    assert.deepEqual(seen, expected.rows.map((row) => row.id), kind);
    assert.equal(new Set(seen).size, 123, kind);
    const position = JSON.parse(Buffer.from(firstCursor, "base64url").toString());
    const invalidIdCursor = Buffer.from(JSON.stringify({ ...position, id: "not-a-uuid" })).toString("base64url");
    await assert.rejects(kind === "review" ? review.listReviewSubmissionPage(actor, { cursor: invalidIdCursor }) : audit.listAdminAuditPage(actor, { cursor: invalidIdCursor }), { code: "INVALID_PAGE_CURSOR" });
  }
  await assert.rejects(review.listReviewSubmissionPage({ id: owner.id, roles: ["author"] }), { code: "REVIEW_ROLE_REQUIRED" });
  await assert.rejects(audit.listAdminAuditPage({ ...actor, roles: ["user"] }), { code: "ADMIN_ROLE_REQUIRED" });
});
