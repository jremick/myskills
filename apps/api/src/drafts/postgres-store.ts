import { assertActionAuthority } from "../auth/postgres-action-authority.js";
import { sql } from "drizzle-orm";
import { AppError } from "@myskills-app/core";
import { validatePackageFiles } from "@myskills-app/skill-package";
import type { Database, DatabaseTransaction } from "../db/client.js";
import { canonicalArtifactPayload } from "../submissions/service.js";
import { artifactPayloadSha256 } from "../submissions/artifact-hash.js";
import { PostgresSubmissionStore } from "../submissions/postgres-submission-store.js";
import type { Draft, DraftSource, DraftStore, DraftSummary } from "./types.js";

type Row = Record<string, unknown>;
const SUMMARY = sql`d.id, d.source, d.created_at AS draft_created_at, d.updated_at,
  r.revision, r.title, r.file_count, r.text_bytes, r.created_at AS revision_created_at,
  r.submission_id, r.submission_slug, r.submission_version, r.submission_artifact_sha256`;
const HEAD = sql`${SUMMARY}, r.files`;

export class PostgresDraftStore implements DraftStore {
  constructor(private readonly db: Database) {}

  async list(ownerId: string): Promise<DraftSummary[]> {
    const result = await this.db.execute(sql`SELECT ${SUMMARY} FROM author_drafts d
      JOIN author_draft_revisions r ON r.draft_id=d.id AND r.revision=d.current_revision
      WHERE d.owner_user_id=${ownerId}::uuid ORDER BY d.updated_at DESC, d.id`);
    return result.rows.map((row) => summary(row));
  }

  async get(ownerId: string, draftId: string, revision?: number): Promise<Draft | null> {
    const result = await this.db.execute(sql`SELECT ${HEAD} FROM author_drafts d
      JOIN author_draft_revisions r ON r.draft_id=d.id AND r.revision=${revision === undefined ? sql`d.current_revision` : sql`${revision}`}
      WHERE d.id=${draftId}::uuid AND d.owner_user_id=${ownerId}::uuid`);
    return result.rows[0] ? draft(result.rows[0], revision !== undefined) : null;
  }

  async history(ownerId: string, draftId: string): Promise<DraftSummary[] | null> {
    const exists = await this.db.execute(sql`SELECT id FROM author_drafts WHERE id=${draftId}::uuid AND owner_user_id=${ownerId}::uuid`);
    if (!exists.rows.length) return null;
    const result = await this.db.execute(sql`SELECT ${SUMMARY} FROM author_drafts d
      JOIN author_draft_revisions r ON r.draft_id=d.id
      WHERE d.id=${draftId}::uuid AND d.owner_user_id=${ownerId}::uuid ORDER BY r.revision DESC`);
    return result.rows.map((row) => summary(row, true));
  }

  async create(input: Parameters<DraftStore["create"]>[0]): Promise<Draft> {
    const id = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`author-drafts:${input.ownerId}`}, 0))`);
      const scopes = ["skills:submit" as const, ...(input.source ? [input.source.kind === "release" ? "skills:read" as const : "submissions:read" as const] : [])];
      await assertActionAuthority(tx, input.actor, scopes, "author");
      await input.authorizeSource?.(tx);
      const count = await tx.execute(sql`SELECT count(*)::int AS n FROM author_drafts WHERE owner_user_id=${input.ownerId}::uuid`);
      if (Number(count.rows[0]?.n) >= 100) throw new AppError("An author can retain at most 100 drafts.", "DRAFT_LIMIT", 409);
      const created = await tx.execute(sql`INSERT INTO author_drafts (owner_user_id, source)
        VALUES (${input.ownerId}::uuid, ${input.source === null ? null : JSON.stringify(input.source)}::jsonb) RETURNING id`);
      const draftId = String(created.rows[0]?.id);
      await insertRevision(tx, draftId, 1, input.title, input.files);
      await assertActionAuthority(tx, input.actor, scopes, "author");
      return draftId;
    });
    return (await this.get(input.ownerId, id))!;
  }

  async save(input: Parameters<DraftStore["save"]>[0]): Promise<Draft> {
    await this.db.transaction(async (tx) => {
      await lockHead(tx, input);
      await assertActionAuthority(tx, input.actor, ["skills:submit"], "author");
      if (input.expectedRevision >= 100) throw new AppError("A draft can retain at most 100 saved revisions.", "DRAFT_HISTORY_LIMIT", 409);
      await insertRevision(tx, input.draftId, input.expectedRevision + 1, input.title, input.files);
      await tx.execute(sql`UPDATE author_drafts SET current_revision=current_revision+1, updated_at=now()
        WHERE id=${input.draftId}::uuid`);
      await assertActionAuthority(tx, input.actor, ["skills:submit"], "author");
    });
    return (await this.get(input.ownerId, input.draftId, input.expectedRevision + 1))!;
  }

  submissionBinding(input: Parameters<DraftStore["submissionBinding"]>[0]) {
    return {
      beforeVersionInsert: async (tx: DatabaseTransaction) => {
        await lockHead(tx, input);
        const result = await tx.execute(sql`SELECT package_digest, submission_id FROM author_draft_revisions
          WHERE draft_id=${input.draftId}::uuid AND revision=${input.expectedRevision} FOR UPDATE`);
        const row = result.rows[0];
        if (row?.package_digest !== input.digest) throw revisionConflict();
        if (row.submission_id) throw new AppError("This saved revision was already submitted.", "DRAFT_ALREADY_SUBMITTED", 409);
      },
      afterVersionInsert: async (tx: DatabaseTransaction, context: { versionId: string; artifactSha256: string }) => {
        if (context.artifactSha256 !== input.digest) throw new AppError("The submitted bytes changed.", "DRAFT_DIGEST_MISMATCH", 409);
        await tx.execute(sql`UPDATE author_draft_revisions SET submission_id=${context.versionId}::uuid,
          submission_slug=${input.slug}, submission_version=${input.version}, submission_artifact_sha256=${context.artifactSha256}
          WHERE draft_id=${input.draftId}::uuid AND revision=${input.expectedRevision}`);
      },
    };
  }

  async authorizeSource(tx: DatabaseTransaction, ownerId: string, source: DraftSource): Promise<void> {
    await tx.execute(sql`LOCK TABLE instance_settings IN SHARE MODE`);
    // Release lifecycle/sharing mutations lock these same registry rows.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`submission:${source.slug}`}, 0))`);
    const row = await tx.execute(sql`SELECT s.id FROM skills s JOIN skill_versions v ON v.skill_id=s.id
      JOIN skill_artifacts a ON a.skill_version_id=v.id WHERE s.slug=${source.slug} AND v.version=${source.version}
        AND a.sha256=${source.artifactSha256}
        ${source.kind === "submission" ? sql`AND v.id=${source.submissionId}::uuid AND s.owner_user_id=${ownerId}::uuid AND s.owner_team_id IS NULL` : sql``}
      FOR SHARE OF s, v, a`);
    if (!row.rows.length) throw sourceUnavailable();
    if (source.kind === "release") {
      // Membership/policy writers lock their aggregate first. Retain those
      // same authorities through the private copy, including allocation waits.
      await tx.execute(sql`SELECT t.id FROM teams t WHERE t.id IN (SELECT team_id FROM team_memberships WHERE user_id=${ownerId}::uuid
        UNION SELECT g.team_id FROM skill_team_grants g JOIN skills s ON s.id=g.skill_id WHERE s.slug=${source.slug}
        UNION SELECT owner_team_id FROM skills WHERE slug=${source.slug}) ORDER BY t.id FOR SHARE`);
      await tx.execute(sql`SELECT o.id FROM organizations o WHERE o.id IN (SELECT organization_id FROM organization_memberships WHERE user_id=${ownerId}::uuid
        UNION SELECT g.organization_id FROM skill_organization_grants g JOIN skills s ON s.id=g.skill_id WHERE s.slug=${source.slug}
        UNION SELECT t.organization_id FROM teams t WHERE t.id IN (SELECT team_id FROM team_memberships WHERE user_id=${ownerId}::uuid
          UNION SELECT g.team_id FROM skill_team_grants g JOIN skills s ON s.id=g.skill_id WHERE s.slug=${source.slug}
          UNION SELECT owner_team_id FROM skills WHERE slug=${source.slug}) AND t.organization_id IS NOT NULL) ORDER BY o.id FOR SHARE`);
      const actor = await tx.execute(sql`SELECT id FROM users WHERE id=${ownerId}::uuid AND status='active' AND email_verified_at IS NOT NULL FOR SHARE`);
      if (!actor.rows.length) throw sourceUnavailable();
      // Reuse the registry's current visibility/lifecycle policy without another object read.
      const authority = new PostgresSubmissionStore(tx as unknown as Database);
      const current = await authority.getPublicRelease({ slug: source.slug, version: source.version, actorId: ownerId });
      if (!current || current.artifact.sha256 !== source.artifactSha256
        || (source.platform && !current.platforms.some((platform) => platform.name === source.platform && platform.status === "supported"))) throw sourceUnavailable();
    }
  }
}

async function lockHead(tx: DatabaseTransaction, input: { ownerId: string; draftId: string; expectedRevision: number }) {
  const result = await tx.execute(sql`SELECT current_revision FROM author_drafts
    WHERE id=${input.draftId}::uuid AND owner_user_id=${input.ownerId}::uuid FOR UPDATE`);
  if (!result.rows[0]) throw new AppError("Draft not found.", "DRAFT_NOT_FOUND", 404);
  if (Number(result.rows[0].current_revision) !== input.expectedRevision) throw revisionConflict();
}
async function insertRevision(tx: DatabaseTransaction, draftId: string, revision: number, title: string, files: Draft["files"]) {
  const counts = validatePackageFiles(files);
  const digest = artifactPayloadSha256(canonicalArtifactPayload(files));
  await tx.execute(sql`INSERT INTO author_draft_revisions (draft_id, revision, title, files, file_count, text_bytes, package_digest)
    VALUES (${draftId}::uuid, ${revision}, ${title}, ${JSON.stringify(files)}::jsonb, ${counts.filesScanned}, ${counts.bytesScanned}, ${digest})`);
}
function draft(row: Row, historic = false): Draft {
  return {
    id: String(row.id), title: String(row.title), revision: Number(row.revision), files: row.files as Draft["files"],
    source: row.source as DraftSource | null,
    createdAt: iso(row.draft_created_at), updatedAt: iso(historic ? row.revision_created_at : row.updated_at),
    submission: row.submission_id ? { id: String(row.submission_id), slug: String(row.submission_slug), version: String(row.submission_version), artifactSha256: String(row.submission_artifact_sha256) } : null,
  };
}
function summary(row: Row, historic = false): DraftSummary {
  const { files: _files, ...record } = draft(row, historic);
  return { ...record, fileCount: Number(row.file_count), textBytes: Number(row.text_bytes) };
}
function iso(value: unknown) { return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }
export function revisionConflict() { return new AppError("The saved draft revision changed. Reload before retrying.", "DRAFT_REVISION_CONFLICT", 409); }
export function sourceUnavailable() { return new AppError("Draft source not found.", "DRAFT_SOURCE_NOT_FOUND", 404); }
