import { createHash, randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import {
  AppError,
  type LibraryAttestation,
  type LibraryCandidateFile,
  type LibraryCandidateMapping,
  type LibraryCandidateState,
  type LibraryEventKind,
  type LibraryFinding,
  type LibrarySourceHealth,
  type LibrarySourceRefKind,
  type LibraryTrackingMode,
  type LibraryTransform,
  type ReviewStatus,
  type SecurityStatus,
  type VisibilityScope,
} from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type { Database, DatabaseTransaction } from "../db/client.js";
import type { SubmissionImportBinding } from "../submissions/types.js";
import type { GithubRepositoryInfo, SourceTreeEntry } from "./github-source.js";
import { IMPORTER_VERSION, type HeldFile, type MappingOverrides } from "./packaging.js";

type Db = Database | DatabaseTransaction;
type Row = Record<string, unknown>;

export interface LibraryRecord {
  id: string;
  ownerUserId: string | null;
  ownerTeamId: string | null;
  ownerTeamName: string | null;
  name: string;
  description: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SourceRecord {
  id: string;
  repositoryId: string;
  fullName: string;
  htmlUrl: string;
  defaultBranch: string | null;
  licenseSpdx: string | null;
  archived: boolean;
}

export interface EntryRecord {
  id: string;
  libraryId: string;
  kind: "source" | "skill";
  revision: number;
  title: string;
  sourceId: string | null;
  sourcePath: string;
  refKind: LibrarySourceRefKind | null;
  refValue: string;
  /** Repository name this entry's owner accepted; the shared source row is metadata only. */
  acknowledgedFullName: string | null;
  /** Detected rename or transfer awaiting the owner's acknowledgement. */
  pendingFullName: string | null;
  trackingMode: LibraryTrackingMode;
  health: LibrarySourceHealth;
  nextCheckAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessfulCheckAt: string | null;
  lastErrorCode: string | null;
  attemptCount: number;
  leaseId: string | null;
  lastGoodSnapshotId: string | null;
  skillSlug: string | null;
  lineageId: string | null;
  sourceEntryId: string | null;
  currentAdoptionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotRecord {
  id: string;
  entryId: string;
  sourceId: string;
  sequence: number;
  refKind: LibrarySourceRefKind;
  refValue: string;
  resolvedRef: string | null;
  upstreamLabel: string | null;
  releaseId: string | null;
  commitSha: string;
  treeSha: string;
  complete: boolean;
  orderStatus: "initial" | "ahead" | "identical" | "unverified";
  inventory: SourceTreeEntry[];
  observedAt: string;
}

export interface LineageRecord {
  id: string;
  ownerUserId: string;
  sourceId: string;
  sourcePath: string;
  refKind: LibrarySourceRefKind;
  refValue: string;
  nativeName: string | null;
  slug: string;
  revisionCounter: number;
  headSnapshotId: string | null;
  headObservedAt: string | null;
  headSourceDigest: string | null;
  headFiles: Array<{ path: string; gitBlobSha: string }>;
  mappingOverrides: MappingOverrides;
}

export interface CandidateRecord {
  id: string;
  sourceEntryId: string;
  skillEntryId: string | null;
  lineageId: string;
  ownerUserId: string;
  snapshotId: string;
  previewId: string | null;
  origin: "preview" | "tracking";
  state: LibraryCandidateState;
  sourcePath: string;
  nativeName: string | null;
  profileDigest: string;
  expectedPriorRevision: number;
  expectedVersion: string;
  orderStatus: SnapshotRecord["orderStatus"];
  sourceDigest: string;
  packageDigest: string | null;
  files: HeldFile[] | null;
  fileDigests: LibraryCandidateFile[];
  mapping: LibraryCandidateMapping & { overrides: MappingOverrides; provenance?: CandidateProvenanceDraft };
  findings: LibraryFinding[];
  changes: { added: string[]; changed: string[]; removed: string[] } | null;
  submissionId: string | null;
  orderAcknowledgement: string | null;
  expiresAt: string;
  decidedAt: string | null;
  createdAt: string;
}

export interface CandidateProvenanceDraft {
  files: Array<{ path: string; sourcePath: string; gitBlobSha: string; sha256: string; bytes: number; origin: "upstream" | "repository-notice" }>;
  transforms: LibraryTransform[];
  headFiles: Array<{ path: string; gitBlobSha: string }>;
}

export interface AdoptionRecord {
  id: string;
  entryId: string;
  libraryId: string;
  slug: string;
  version: string;
  artifactSha256: string;
  skillVersionId: string;
  attestation: LibraryAttestation;
  predecessorAdoptionId: string | null;
  actorUserId: string;
  reason: string;
  createdAt: string;
}

export interface BindingRecord {
  id: string;
  entryId: string;
  libraryId: string;
  targetId: string;
  slug: string;
  status: "active" | "curation-unavailable" | "detached";
  pinnedVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseFacts {
  skillVersionId: string;
  skillId: string;
  ownerUserId: string | null;
  visibility: VisibilityScope;
  artifactSha256: string;
  selfReviewed: boolean;
  elevated: boolean;
  lineageId: string | null;
}

export interface SubmissionFacts {
  submissionId: string;
  slug: string;
  version: string;
  reviewStatus: ReviewStatus;
  securityStatus: SecurityStatus;
  publishedAt: string | null;
  selfReviewed: boolean;
  elevated: boolean;
  elevationRequestedAt: string | null;
}

export interface InboxRow {
  id: string;
  libraryId: string;
  libraryName: string;
  entryId: string | null;
  candidateId: string | null;
  kind: LibraryEventKind;
  audience: "curators" | "subscribers";
  version: string | null;
  path: string | null;
  createdAt: string;
  cursorAt: string;
  readAt: string | null;
  subscribedKinds: LibraryEventKind[];
}

export interface PageCursor {
  at: string;
  id: string;
}

export interface LibraryEventInput {
  libraryId: string;
  entryId: string | null;
  candidateId: string | null;
  kind: LibraryEventKind;
  audience: "curators" | "subscribers";
  semanticKey: string;
  version: string | null;
  path: string | null;
}

/** Inbox item a tracking check commits with its candidate; kind and version come from the candidate. */
export interface CandidateNotification {
  libraryId: string;
  semanticKey: string;
  path: string | null;
}

/** A check whose lease another worker now holds stops with this code and reports `lease-lost`. */
export const CHECK_LEASE_LOST = "SOURCE_CHECK_LEASE_LOST";

export function leaseLostError(): AppError {
  return new AppError("The source check lost its lease.", CHECK_LEASE_LOST, 409);
}

export function candidateEvent(candidate: CandidateRecord, notify: CandidateNotification): LibraryEventInput {
  return {
    libraryId: notify.libraryId,
    entryId: candidate.sourceEntryId,
    candidateId: candidate.id,
    kind: candidate.state === "blocked" ? "candidate-blocked" : "candidate-ready",
    audience: "curators",
    semanticKey: notify.semanticKey,
    version: candidate.expectedVersion,
    path: notify.path,
  };
}

export interface RemovalEffects {
  entriesRemoved: number;
  bindingsMarkedCurationUnavailable: number;
  subscriptionsEnded: number;
  candidatesCancelled: number;
}

const LIBRARY_COLUMNS = sql`l.id, l.owner_user_id, l.owner_team_id, t.name AS owner_team_name, l.name, l.description, l.revision, l.created_at, l.updated_at`;
const ENTRY_COLUMNS = sql`e.id, e.library_id, e.kind, e.revision, e.title, e.source_id, e.source_path, e.ref_kind, e.ref_value,
  e.acknowledged_full_name, e.pending_full_name, e.tracking_mode, e.health, e.next_check_at, e.last_attempt_at, e.last_successful_check_at, e.last_error_code, e.attempt_count,
  e.lease_id, e.last_good_snapshot_id, e.skill_slug, e.lineage_id, e.source_entry_id, e.current_adoption_id, e.created_at, e.updated_at`;
const CANDIDATE_COLUMNS = sql`c.id, c.source_entry_id, c.skill_entry_id, c.lineage_id, c.owner_user_id, c.snapshot_id, c.preview_id,
  c.origin, c.state, c.source_path, c.native_name, c.profile_digest, c.expected_prior_revision, c.expected_version, c.order_status, c.source_digest,
  c.package_digest, c.files, c.file_digests, c.mapping, c.findings, c.changes, c.submission_id, c.order_acknowledgement,
  c.expires_at, c.decided_at, c.created_at`;
const CURSOR_AT = (column: SQL) => sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Effective team role at read time, including organization-parent rules. */
function effectiveTeamRole(teamId: SQL, actorId: string): SQL {
  return sql`(
    SELECT tm.role::text FROM team_memberships tm
    JOIN teams team ON team.id = tm.team_id
    LEFT JOIN organizations org ON org.id = team.organization_id
    LEFT JOIN organization_policy_revisions opr
      ON opr.organization_id = team.organization_id AND opr.id = org.current_policy_revision_id
    LEFT JOIN organization_memberships om
      ON om.organization_id = team.organization_id AND om.user_id = ${actorId}::uuid AND om.removed_at IS NULL
    WHERE tm.team_id = ${teamId} AND tm.user_id = ${actorId}::uuid
      AND (
        team.organization_id IS NULL
        OR (
          org.status = 'active' AND org.current_policy_revision_id IS NOT NULL AND opr.id IS NOT NULL
          AND (coalesce(opr.policy->'teams'->>'requireOrganizationMembershipForTeamMembers', 'true') = 'false' OR om.id IS NOT NULL)
        )
      )
    LIMIT 1
  )`;
}

export class PostgresLibraryStore {
  constructor(private readonly db: Database) {}

  // ---- Admin settings -----------------------------------------------------

  async getSettings(): Promise<{ privateSelfReviewEnabled: boolean; updatedAt: string | null }> {
    const result = await this.db.execute<{ value: unknown; updated_at: unknown }>(sql`SELECT value, updated_at FROM instance_settings WHERE key = 'library'`);
    const row = result.rows[0];
    return {
      privateSelfReviewEnabled: Boolean(row && isRecord(row.value) && row.value.privateSelfReviewEnabled === true),
      updatedAt: row ? isoOrNull(row.updated_at) : null,
    };
  }

  async updateSettings(input: { actorId: string; privateSelfReviewEnabled: boolean; reason?: string }): Promise<{ privateSelfReviewEnabled: boolean; updatedAt: string | null }> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO instance_settings (key, value, updated_at)
        VALUES ('library', ${JSON.stringify({ privateSelfReviewEnabled: input.privateSelfReviewEnabled })}::jsonb, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `);
      await audit(tx, {
        actorUserId: input.actorId,
        action: "admin.library_settings.update",
        resourceType: "instance_setting",
        details: { setting: "library", privateSelfReviewEnabled: input.privateSelfReviewEnabled, reason: input.reason },
      });
    });
    return this.getSettings();
  }

  // ---- Libraries ----------------------------------------------------------

  async createLibrary(input: {
    ownerUserId: string | null;
    ownerTeamId: string | null;
    name: string;
    description: string;
    actorId: string;
    clientMutationId: string | null;
    clientMutationDigest: string;
    maxPerOwner: number;
  }): Promise<{ id: string; replayed: boolean }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`library-create:${input.ownerUserId ?? input.ownerTeamId}`}, 0))`);
      if (input.clientMutationId) {
        const replay = await replayMutation(tx, sql`libraries`, input.actorId, input.clientMutationId, input.clientMutationDigest);
        if (replay) return { id: replay, replayed: true };
      }
      const count = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM libraries
        WHERE status = 'active' AND ${input.ownerUserId ? sql`owner_user_id = ${input.ownerUserId}::uuid` : sql`owner_team_id = ${input.ownerTeamId}::uuid`}
      `);
      if ((count.rows[0]?.count ?? 0) >= input.maxPerOwner) {
        throw new AppError("The owner has reached the library limit.", "LIBRARY_LIMIT_EXCEEDED", 422, { limit: input.maxPerOwner });
      }
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO libraries (owner_user_id, owner_team_id, name, description, created_by_user_id, client_mutation_id, client_mutation_digest)
        VALUES (${input.ownerUserId}::uuid, ${input.ownerTeamId}::uuid, ${input.name}, ${input.description}, ${input.actorId}::uuid,
          ${input.clientMutationId}, ${input.clientMutationDigest})
        RETURNING id
      `);
      const id = inserted.rows[0]!.id;
      await audit(tx, { actorUserId: input.actorId, action: "library.create", resourceType: "library", resourceId: id, details: { ownerType: input.ownerUserId ? "user" : "team" } });
      return { id, replayed: false };
    });
  }

  async getLibrary(id: string): Promise<LibraryRecord | null> {
    if (!isUuid(id)) return null;
    const result = await this.db.execute<Row>(sql`
      SELECT ${LIBRARY_COLUMNS} FROM libraries l LEFT JOIN teams t ON t.id = l.owner_team_id
      WHERE l.id = ${id}::uuid AND l.status = 'active'
    `);
    return result.rows[0] ? libraryRecord(result.rows[0]) : null;
  }

  async teamRole(teamId: string, actorId: string): Promise<"owner" | "member" | null> {
    if (!isUuid(teamId)) return null;
    const result = await this.db.execute<{ role: string | null }>(sql`SELECT ${effectiveTeamRole(sql`${teamId}::uuid`, actorId)} AS role`);
    const role = result.rows[0]?.role;
    return role === "owner" || role === "member" ? role : null;
  }

  async listLibrariesForActor(actorId: string, page: { limit: number; cursor: PageCursor | null }): Promise<Array<LibraryRecord & { role: "owner" | "member"; cursorAt: string }>> {
    const teamRole = effectiveTeamRole(sql`l.owner_team_id`, actorId);
    const result = await this.db.execute<Row>(sql`
      SELECT ${LIBRARY_COLUMNS}, ${CURSOR_AT(sql`l.created_at`)} AS cursor_at,
        CASE WHEN l.owner_user_id IS NOT NULL THEN 'owner' ELSE ${teamRole} END AS role
      FROM libraries l LEFT JOIN teams t ON t.id = l.owner_team_id
      WHERE l.status = 'active'
        AND (l.owner_user_id = ${actorId}::uuid OR (l.owner_team_id IS NOT NULL AND ${teamRole} IS NOT NULL))
        ${page.cursor ? sql`AND (l.created_at, l.id) < (${page.cursor.at}::timestamptz, ${page.cursor.id}::uuid)` : sql``}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT ${page.limit + 1}
    `);
    return result.rows.map((row) => ({ ...libraryRecord(row), role: row.role === "owner" ? "owner" as const : "member" as const, cursorAt: String(row.cursor_at) }));
  }

  async updateLibrary(input: { id: string; expectedRevision: number; name?: string; description?: string; actorId: string }): Promise<LibraryRecord> {
    await this.db.transaction(async (tx) => {
      const current = await tx.execute<{ revision: number }>(sql`SELECT revision FROM libraries WHERE id = ${input.id}::uuid AND status = 'active' FOR UPDATE`);
      const revision = current.rows[0]?.revision;
      if (revision === undefined) throw notFound("LIBRARY_NOT_FOUND", "Library not found.");
      if (revision !== input.expectedRevision) throw revisionConflict(revision);
      await tx.execute(sql`
        UPDATE libraries SET
          name = coalesce(${input.name ?? null}, name),
          description = coalesce(${input.description ?? null}, description),
          revision = revision + 1, updated_at = now()
        WHERE id = ${input.id}::uuid
      `);
      await audit(tx, { actorUserId: input.actorId, action: "library.update", resourceType: "library", resourceId: input.id, details: { fields: [input.name !== undefined ? "name" : null, input.description !== undefined ? "description" : null].filter(Boolean) } });
    });
    const library = await this.getLibrary(input.id);
    if (!library) throw notFound("LIBRARY_NOT_FOUND", "Library not found.");
    return library;
  }

  async deleteLibrary(input: { id: string; expectedRevision: number; actorId: string }): Promise<RemovalEffects> {
    return this.db.transaction(async (tx) => {
      const current = await tx.execute<{ revision: number }>(sql`SELECT revision FROM libraries WHERE id = ${input.id}::uuid AND status = 'active' FOR UPDATE`);
      const revision = current.rows[0]?.revision;
      if (revision === undefined) throw notFound("LIBRARY_NOT_FOUND", "Library not found.");
      if (revision !== input.expectedRevision) throw revisionConflict(revision);
      const entries = await tx.execute<{ id: string }>(sql`SELECT id FROM library_entries WHERE library_id = ${input.id}::uuid AND status = 'active' ORDER BY id FOR UPDATE`);
      const effects: RemovalEffects = { entriesRemoved: 0, bindingsMarkedCurationUnavailable: 0, subscriptionsEnded: 0, candidatesCancelled: 0 };
      for (const entry of entries.rows) {
        const removed = await removeEntryInTransaction(tx, entry.id, input.actorId);
        effects.entriesRemoved += 1;
        effects.bindingsMarkedCurationUnavailable += removed.bindingsMarkedCurationUnavailable;
        effects.candidatesCancelled += removed.candidatesCancelled;
      }
      const subscriptions = await tx.execute<{ user_id: string }>(sql`DELETE FROM library_subscriptions WHERE library_id = ${input.id}::uuid RETURNING user_id`);
      effects.subscriptionsEnded = subscriptions.rows.length;
      await tx.execute(sql`UPDATE libraries SET status = 'deleted', deleted_at = now(), revision = revision + 1, updated_at = now() WHERE id = ${input.id}::uuid`);
      await audit(tx, { actorUserId: input.actorId, action: "library.delete", resourceType: "library", resourceId: input.id, details: { ...effects } });
      return effects;
    });
  }

  // ---- Sources ------------------------------------------------------------

  async upsertSource(info: GithubRepositoryInfo): Promise<SourceRecord> {
    const result = await this.db.execute<Row>(sql`
      INSERT INTO library_sources (provider, repository_id, full_name, html_url, default_branch, license_spdx, archived, url_history)
      VALUES ('github', ${info.id}, ${info.fullName}, ${info.htmlUrl}, ${info.defaultBranch}, ${info.licenseSpdx}, ${info.archived},
        ${JSON.stringify([info.htmlUrl])}::jsonb)
      ON CONFLICT ON CONSTRAINT library_sources_identity_unique DO UPDATE SET
        full_name = EXCLUDED.full_name,
        html_url = EXCLUDED.html_url,
        default_branch = EXCLUDED.default_branch,
        license_spdx = EXCLUDED.license_spdx,
        archived = EXCLUDED.archived,
        url_history = CASE WHEN library_sources.url_history @> jsonb_build_array(EXCLUDED.html_url) THEN library_sources.url_history
          ELSE library_sources.url_history || jsonb_build_array(EXCLUDED.html_url) END,
        updated_at = now()
      RETURNING id, repository_id, full_name, html_url, default_branch, license_spdx, archived
    `);
    return sourceRecord(result.rows[0]!);
  }

  async getSource(id: string): Promise<SourceRecord | null> {
    const result = await this.db.execute<Row>(sql`SELECT id, repository_id, full_name, html_url, default_branch, license_spdx, archived FROM library_sources WHERE id = ${id}::uuid`);
    return result.rows[0] ? sourceRecord(result.rows[0]) : null;
  }

  // ---- Entries ------------------------------------------------------------

  async createEntry(input: {
    libraryId: string;
    kind: "source" | "skill";
    title: string;
    sourceId?: string;
    sourcePath?: string;
    refKind?: LibrarySourceRefKind;
    refValue?: string;
    acknowledgedFullName?: string;
    skillSlug?: string;
    actorId: string;
    clientMutationId: string | null;
    clientMutationDigest: string;
    maxPerLibrary: number;
  }): Promise<{ id: string; replayed: boolean }> {
    return this.db.transaction(async (tx) => {
      const library = await tx.execute<{ id: string }>(sql`SELECT id FROM libraries WHERE id = ${input.libraryId}::uuid AND status = 'active' FOR UPDATE`);
      if (!library.rows[0]) throw notFound("LIBRARY_NOT_FOUND", "Library not found.");
      if (input.clientMutationId) {
        const replay = await replayMutation(tx, sql`library_entries`, input.actorId, input.clientMutationId, input.clientMutationDigest);
        if (replay) return { id: replay, replayed: true };
      }
      const count = await tx.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM library_entries WHERE library_id = ${input.libraryId}::uuid AND status = 'active'`);
      if ((count.rows[0]?.count ?? 0) >= input.maxPerLibrary) {
        throw new AppError("The library has reached its entry limit.", "LIBRARY_LIMIT_EXCEEDED", 422, { limit: input.maxPerLibrary });
      }
      const duplicate = await tx.execute<{ id: string }>(input.kind === "source" ? sql`
        SELECT id FROM library_entries WHERE library_id = ${input.libraryId}::uuid AND kind = 'source' AND status = 'active'
          AND source_id = ${input.sourceId ?? null}::uuid AND source_path = ${input.sourcePath ?? ""}
          AND ref_kind = ${input.refKind ?? null} AND ref_value = ${input.refValue ?? ""}
      ` : sql`
        SELECT id FROM library_entries WHERE library_id = ${input.libraryId}::uuid AND kind = 'skill' AND status = 'active'
          AND skill_slug = ${input.skillSlug ?? null}
      `);
      if (duplicate.rows[0]) throw new AppError("The library already contains this entry.", "LIBRARY_ENTRY_DUPLICATE", 409, { entryId: duplicate.rows[0].id });
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO library_entries (library_id, kind, title, source_id, source_path, ref_kind, ref_value, acknowledged_full_name, skill_slug,
          created_by_user_id, client_mutation_id, client_mutation_digest)
        VALUES (${input.libraryId}::uuid, ${input.kind}, ${input.title}, ${input.sourceId ?? null}::uuid, ${input.sourcePath ?? ""},
          ${input.refKind ?? null}, ${input.refValue ?? ""}, ${input.acknowledgedFullName ?? null}, ${input.skillSlug ?? null},
          ${input.actorId}::uuid, ${input.clientMutationId}, ${input.clientMutationDigest})
        RETURNING id
      `);
      const id = inserted.rows[0]!.id;
      await audit(tx, { actorUserId: input.actorId, action: "library.entry.create", resourceType: "library_entry", resourceId: id, details: { libraryId: input.libraryId, kind: input.kind } });
      return { id, replayed: false };
    });
  }

  async getEntry(id: string): Promise<EntryRecord | null> {
    if (!isUuid(id)) return null;
    const result = await this.db.execute<Row>(sql`SELECT ${ENTRY_COLUMNS} FROM library_entries e WHERE e.id = ${id}::uuid AND e.status = 'active'`);
    return result.rows[0] ? entryRecord(result.rows[0]) : null;
  }

  async listEntries(libraryId: string, input: { kind?: "source" | "skill"; limit: number; cursor: PageCursor | null }): Promise<Array<EntryRecord & { cursorAt: string }>> {
    const result = await this.db.execute<Row>(sql`
      SELECT ${ENTRY_COLUMNS}, ${CURSOR_AT(sql`e.created_at`)} AS cursor_at FROM library_entries e
      WHERE e.library_id = ${libraryId}::uuid AND e.status = 'active'
        ${input.kind ? sql`AND e.kind = ${input.kind}` : sql``}
        ${input.cursor ? sql`AND (e.created_at, e.id) < (${input.cursor.at}::timestamptz, ${input.cursor.id}::uuid)` : sql``}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ${input.limit + 1}
    `);
    return result.rows.map((row) => ({ ...entryRecord(row), cursorAt: String(row.cursor_at) }));
  }

  async removeEntry(entryId: string, actorId: string): Promise<RemovalEffects & { trackingStopped: boolean }> {
    return this.db.transaction(async (tx) => {
      const effects = await removeEntryInTransaction(tx, entryId, actorId);
      return { ...effects, entriesRemoved: 1, subscriptionsEnded: 0 };
    });
  }

  async updateTracking(input: {
    entryId: string;
    expectedRevision: number;
    mode: LibraryTrackingMode;
    nextCheckAt: Date | null;
    acknowledgeIdentityChange: boolean;
    actorId: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const current = await tx.execute<{ revision: number; health: string; acknowledged_full_name: string | null; pending_full_name: string | null }>(sql`
        SELECT revision, health, acknowledged_full_name, pending_full_name FROM library_entries
        WHERE id = ${input.entryId}::uuid AND status = 'active' AND kind = 'source' FOR UPDATE
      `);
      const row = current.rows[0];
      if (!row) throw notFound("LIBRARY_ENTRY_NOT_FOUND", "Library entry not found.");
      if (row.revision !== input.expectedRevision) throw revisionConflict(row.revision);
      // The review lives on the entry, so turning tracking off and on again cannot skip it.
      const pending = row.pending_full_name;
      if (input.acknowledgeIdentityChange && !pending) {
        throw new AppError("No repository identity change is waiting for acknowledgement.", "IDENTITY_ACKNOWLEDGEMENT_NOT_APPLICABLE", 409);
      }
      if (pending && !input.acknowledgeIdentityChange && (input.mode === "daily" || input.mode === "weekly")) {
        throw new AppError("The source identity changed. Review it and acknowledge before tracking resumes.", "SOURCE_IDENTITY_CHANGED", 409);
      }
      const health = pending && !input.acknowledgeIdentityChange ? "identity-change-review"
        : input.mode === "off" ? "not-tracked"
          : row.health === "not-tracked" || row.health === "identity-change-review" ? "healthy" : row.health;
      await tx.execute(sql`
        UPDATE library_entries SET tracking_mode = ${input.mode}, next_check_at = ${input.nextCheckAt ? input.nextCheckAt.toISOString() : null}::timestamptz,
          health = ${health}, attempt_count = 0,
          acknowledged_full_name = CASE WHEN ${input.acknowledgeIdentityChange}::boolean THEN pending_full_name ELSE acknowledged_full_name END,
          pending_full_name = CASE WHEN ${input.acknowledgeIdentityChange}::boolean THEN NULL ELSE pending_full_name END,
          last_error_code = CASE WHEN ${input.acknowledgeIdentityChange}::boolean THEN NULL ELSE last_error_code END,
          revision = revision + 1, updated_at = now()
        WHERE id = ${input.entryId}::uuid
      `);
      await audit(tx, {
        actorUserId: input.actorId,
        action: "library.entry.tracking.update",
        resourceType: "library_entry",
        resourceId: input.entryId,
        details: {
          mode: input.mode,
          acknowledgeIdentityChange: input.acknowledgeIdentityChange,
          ...(input.acknowledgeIdentityChange ? { identity: { from: row.acknowledged_full_name, to: pending } } : {}),
        },
      });
    });
  }

  /**
   * Record a detected rename or transfer on this entry only. A new pending
   * name bumps the entry revision, so an acknowledgement sent from an older
   * view fails with a revision conflict. With a lease, the write is fenced
   * by it and releases it, and the check's alert commits in the same
   * transaction; `marked` is false when the lease was lost.
   */
  async markIdentityChange(entryId: string, leaseId: string | null, source: GithubRepositoryInfo, alert?: LibraryEventInput): Promise<{ marked: boolean; alerted: boolean }> {
    return this.db.transaction(async (tx) => {
      if (!await lockEntryForWrite(tx, entryId, leaseId)) return { marked: false, alerted: false };
      const updated = await tx.execute<{ source_id: string }>(sql`
        UPDATE library_entries SET health = 'identity-change-review', last_error_code = 'source-identity-changed',
          pending_full_name = ${source.fullName},
          revision = CASE WHEN pending_full_name IS DISTINCT FROM ${source.fullName}::text THEN revision + 1 ELSE revision END,
          lease_id = CASE WHEN ${leaseId}::uuid IS NULL THEN lease_id ELSE NULL END,
          lease_expires_at = CASE WHEN ${leaseId}::uuid IS NULL THEN lease_expires_at ELSE NULL END,
          updated_at = now()
        WHERE id = ${entryId}::uuid AND status = 'active' AND kind = 'source' AND (${leaseId}::uuid IS NULL OR lease_id = ${leaseId}::uuid)
        RETURNING source_id
      `);
      const sourceId = updated.rows[0]?.source_id;
      if (!sourceId) return { marked: false, alerted: false };
      await tx.execute(sql`
        UPDATE library_sources SET url_history = CASE WHEN url_history @> jsonb_build_array(${source.htmlUrl}::text) THEN url_history
          ELSE url_history || jsonb_build_array(${source.htmlUrl}::text) END, updated_at = now()
        WHERE id = ${sourceId}::uuid
      `);
      return { marked: true, alerted: alert ? await insertEvent(tx, alert) : false };
    });
  }

  // ---- Snapshots ----------------------------------------------------------

  async insertSnapshot(input: {
    entryId: string;
    sourceId: string;
    refKind: LibrarySourceRefKind;
    refValue: string;
    resolvedRef: string | null;
    upstreamLabel: string | null;
    releaseId: string | null;
    commitSha: string;
    treeSha: string;
    complete: boolean;
    orderStatus: SnapshotRecord["orderStatus"];
    inventory: SourceTreeEntry[];
    inventoryDigest: string;
    observedAt: Date;
    setLastGood: boolean;
    /** A check's lease; the snapshot commits only while it is held. Discovery passes none. */
    leaseId?: string | null;
  }): Promise<SnapshotRecord> {
    return this.db.transaction(async (tx) => {
      if (!await lockEntryForWrite(tx, input.entryId, input.leaseId ?? null)) {
        throw input.leaseId ? leaseLostError() : notFound("LIBRARY_ENTRY_NOT_FOUND", "Library entry not found.");
      }
      const existing = input.complete ? await selectReusableSnapshot(tx, input) : null;
      if (existing) {
        if (input.setLastGood) {
          await tx.execute(sql`UPDATE library_entries SET last_good_snapshot_id = ${existing.id}::uuid, updated_at = now() WHERE id = ${input.entryId}::uuid`);
        }
        return existing;
      }
      const inserted = await tx.execute<Row>(sql`
        INSERT INTO library_source_snapshots (entry_id, source_id, sequence, ref_kind, ref_value, resolved_ref, upstream_label, release_id,
          commit_sha, tree_sha, complete, order_status, inventory, inventory_digest, observed_at)
        SELECT ${input.entryId}::uuid, ${input.sourceId}::uuid,
          coalesce((SELECT max(sequence) FROM library_source_snapshots WHERE entry_id = ${input.entryId}::uuid), 0) + 1,
          ${input.refKind}::text, ${input.refValue}::text, ${input.resolvedRef}::text, ${input.upstreamLabel}::text, ${input.releaseId}::text,
          ${input.commitSha}::text, ${input.treeSha}::text, ${input.complete}::boolean, ${input.orderStatus}::text,
          ${JSON.stringify(input.inventory)}::jsonb, ${input.inventoryDigest}::text, ${input.observedAt.toISOString()}::timestamptz
        RETURNING id, entry_id, source_id, sequence::int AS sequence, ref_kind, ref_value, resolved_ref, upstream_label, release_id,
          commit_sha, tree_sha, complete, order_status, inventory, observed_at
      `);
      const snapshot = snapshotRecord(inserted.rows[0]!);
      if (input.setLastGood && input.complete) {
        await tx.execute(sql`UPDATE library_entries SET last_good_snapshot_id = ${snapshot.id}::uuid, updated_at = now() WHERE id = ${input.entryId}::uuid`);
      }
      return snapshot;
    });
  }

  /** The entry's newest snapshot when it is complete and has the same upstream state; reused by retries and repeated discovery. */
  async findReusableSnapshot(input: SnapshotIdentity): Promise<SnapshotRecord | null> {
    return selectReusableSnapshot(this.db, input);
  }

  async markLastGoodSnapshot(entryId: string, snapshotId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE library_entries SET last_good_snapshot_id = ${snapshotId}::uuid, updated_at = now()
      WHERE id = ${entryId}::uuid AND last_good_snapshot_id IS NULL
    `);
  }

  async getSnapshot(id: string | null): Promise<SnapshotRecord | null> {
    if (!id || !isUuid(id)) return null;
    const result = await this.db.execute<Row>(sql`
      SELECT id, entry_id, source_id, sequence::int AS sequence, ref_kind, ref_value, resolved_ref, upstream_label, release_id,
        commit_sha, tree_sha, complete, order_status, inventory, observed_at
      FROM library_source_snapshots WHERE id = ${id}::uuid
    `);
    return result.rows[0] ? snapshotRecord(result.rows[0]) : null;
  }

  // ---- Lineages -----------------------------------------------------------

  async findLineage(input: { ownerUserId: string; sourceId: string; sourcePath: string; refKind: LibrarySourceRefKind; refValue: string }): Promise<LineageRecord | null> {
    const result = await this.db.execute<Row>(sql`
      SELECT * FROM library_import_lineages
      WHERE owner_user_id = ${input.ownerUserId}::uuid AND source_id = ${input.sourceId}::uuid AND source_path = ${input.sourcePath}
        AND ref_kind = ${input.refKind} AND ref_value = ${input.refValue}
    `);
    return result.rows[0] ? lineageRecord(result.rows[0]) : null;
  }

  async getLineage(id: string | null): Promise<LineageRecord | null> {
    if (!id || !isUuid(id)) return null;
    const result = await this.db.execute<Row>(sql`SELECT * FROM library_import_lineages WHERE id = ${id}::uuid`);
    return result.rows[0] ? lineageRecord(result.rows[0]) : null;
  }

  /**
   * Reserve an import lineage and its opaque registry slug. A slug already
   * used by any registry skill or lineage is never reused; collisions retry
   * with a new suffix and disclose nothing about the other owner.
   */
  async reserveLineage(input: {
    ownerUserId: string;
    sourceId: string;
    sourcePath: string;
    refKind: LibrarySourceRefKind;
    refValue: string;
    nativeName: string | null;
    slugForAttempt: (attempt: number) => string;
  }): Promise<LineageRecord> {
    const existing = await this.findLineage(input);
    if (existing) return existing;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const slug = input.slugForAttempt(attempt);
      const reserved = await this.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`submission:${slug}`}, 0))`);
        const taken = await tx.execute<{ taken: boolean }>(sql`
          SELECT EXISTS (SELECT 1 FROM skills WHERE slug = ${slug}) OR EXISTS (SELECT 1 FROM library_import_lineages WHERE slug = ${slug}) AS taken
        `);
        if (taken.rows[0]?.taken) return null;
        const inserted = await tx.execute<Row>(sql`
          INSERT INTO library_import_lineages (owner_user_id, source_id, source_path, ref_kind, ref_value, native_name, slug)
          VALUES (${input.ownerUserId}::uuid, ${input.sourceId}::uuid, ${input.sourcePath}, ${input.refKind}, ${input.refValue}, ${input.nativeName}, ${slug})
          ON CONFLICT ON CONSTRAINT library_import_lineages_identity_unique DO NOTHING
          RETURNING *
        `);
        return inserted.rows[0] ? lineageRecord(inserted.rows[0]) : "raced" as const;
      });
      if (reserved === "raced") {
        const winner = await this.findLineage(input);
        if (winner) return winner;
      } else if (reserved) {
        return reserved;
      }
    }
    throw new AppError("An import slug could not be allocated. Retry the preview.", "SLUG_CONFLICT", 409);
  }

  /** Lineages imported from a source entry, via its active skill entries. */
  async lineagesForSourceEntry(sourceEntryId: string): Promise<LineageRecord[]> {
    const result = await this.db.execute<Row>(sql`
      SELECT DISTINCT li.* FROM library_import_lineages li
      JOIN library_entries e ON e.lineage_id = li.id
      WHERE e.source_entry_id = ${sourceEntryId}::uuid AND e.status = 'active' AND e.kind = 'skill'
      ORDER BY li.source_path
    `);
    return result.rows.map(lineageRecord);
  }

  async skillOwnership(slug: string): Promise<{ ownerUserId: string | null; visibility: VisibilityScope } | null> {
    const result = await this.db.execute<{ owner_user_id: string | null; visibility: string }>(sql`SELECT owner_user_id, visibility::text AS visibility FROM skills WHERE slug = ${slug}`);
    const row = result.rows[0];
    return row ? { ownerUserId: row.owner_user_id, visibility: row.visibility as VisibilityScope } : null;
  }

  // ---- Candidates ---------------------------------------------------------

  async insertCandidate(input: {
    sourceEntryId: string;
    lineageId: string;
    ownerUserId: string;
    snapshotId: string;
    snapshotSequence: number;
    snapshotObservedAt: string;
    previewId: string | null;
    origin: "preview" | "tracking";
    state: "ready-for-review" | "blocked";
    sourcePath: string;
    nativeName: string | null;
    profileDigest: string;
    expectedPriorRevision: number;
    expectedVersion: string;
    orderStatus: CandidateRecord["orderStatus"];
    sourceDigest: string;
    packageDigest: string | null;
    files: HeldFile[] | null;
    fileDigests: LibraryCandidateFile[];
    mapping: CandidateRecord["mapping"];
    findings: LibraryFinding[];
    changes: CandidateRecord["changes"];
    expiresAt: Date;
    supersedeOlder: boolean;
    /** A tracking check's lease; the candidate and its notification commit only while it is held. */
    leaseId?: string | null;
    notify?: CandidateNotification | null;
  }): Promise<{ candidate: CandidateRecord; created: boolean; notified: LibraryEventKind | null }> {
    return this.db.transaction(async (tx) => {
      // Tracking locks the source entry before the lineage and candidates, as entry removal does. Previews take no entry lock.
      if (input.leaseId && !await lockEntryForWrite(tx, input.sourceEntryId, input.leaseId)) throw leaseLostError();
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`library-lineage:${input.lineageId}`}, 0))`);
      const existing = await tx.execute<Row>(sql`
        SELECT ${CANDIDATE_COLUMNS} FROM library_import_candidates c
        WHERE c.lineage_id = ${input.lineageId}::uuid AND c.snapshot_id = ${input.snapshotId}::uuid AND c.profile_digest = ${input.profileDigest}
          AND c.state IN ('ready-for-review', 'blocked', 'accepted')
      `);
      if (existing.rows[0]) {
        const candidate = candidateRecord(existing.rows[0]);
        return { candidate, created: false, notified: await notifyCandidate(tx, candidate, input.notify ?? null) };
      }
      const inserted = await tx.execute<Row>(sql`
        INSERT INTO library_import_candidates (source_entry_id, lineage_id, owner_user_id, snapshot_id, snapshot_sequence, preview_id, origin, state,
          source_path, native_name, profile_digest, expected_prior_revision, expected_version, order_status, source_digest, package_digest,
          files, file_digests, mapping, findings, changes, expires_at)
        VALUES (${input.sourceEntryId}::uuid, ${input.lineageId}::uuid, ${input.ownerUserId}::uuid, ${input.snapshotId}::uuid,
          ${input.snapshotSequence}, ${input.previewId}::uuid, ${input.origin}, ${input.state}, ${input.sourcePath}, ${input.nativeName},
          ${input.profileDigest}, ${input.expectedPriorRevision}, ${input.expectedVersion}, ${input.orderStatus}, ${input.sourceDigest}, ${input.packageDigest},
          ${input.files ? JSON.stringify(input.files) : null}::jsonb, ${JSON.stringify(input.fileDigests)}::jsonb,
          ${JSON.stringify(input.mapping)}::jsonb, ${JSON.stringify(input.findings)}::jsonb,
          ${input.changes ? JSON.stringify(input.changes) : null}::jsonb, ${input.expiresAt.toISOString()}::timestamptz)
        RETURNING id
      `);
      const id = String(inserted.rows[0]!.id);
      if (input.supersedeOlder) {
        await tx.execute(sql`
          UPDATE library_import_candidates c SET state = 'superseded', files = NULL, updated_at = now()
          FROM library_source_snapshots s
          WHERE s.id = c.snapshot_id AND c.lineage_id = ${input.lineageId}::uuid AND c.id <> ${id}::uuid
            AND c.state IN ('ready-for-review', 'blocked') AND s.observed_at < ${input.snapshotObservedAt}::timestamptz
        `);
      }
      const candidate = candidateRecord((await tx.execute<Row>(sql`SELECT ${CANDIDATE_COLUMNS} FROM library_import_candidates c WHERE c.id = ${id}::uuid`)).rows[0]!);
      return { candidate, created: true, notified: await notifyCandidate(tx, candidate, input.notify ?? null) };
    });
  }

  async findActiveCandidate(lineageId: string, snapshotId: string, profileDigest: string): Promise<CandidateRecord | null> {
    const result = await this.db.execute<Row>(sql`
      SELECT ${CANDIDATE_COLUMNS} FROM library_import_candidates c
      WHERE c.lineage_id = ${lineageId}::uuid AND c.snapshot_id = ${snapshotId}::uuid AND c.profile_digest = ${profileDigest}
        AND c.state IN ('ready-for-review', 'blocked', 'accepted')
    `);
    return result.rows[0] ? candidateRecord(result.rows[0]) : null;
  }

  async getCandidate(id: string): Promise<CandidateRecord | null> {
    if (!isUuid(id)) return null;
    const result = await this.db.execute<Row>(sql`SELECT ${CANDIDATE_COLUMNS} FROM library_import_candidates c WHERE c.id = ${id}::uuid`);
    return result.rows[0] ? candidateRecord(result.rows[0]) : null;
  }

  async listCandidates(sourceEntryId: string, input: { state?: LibraryCandidateState; limit: number; cursor: PageCursor | null }): Promise<Array<CandidateRecord & { cursorAt: string }>> {
    const result = await this.db.execute<Row>(sql`
      SELECT ${CANDIDATE_COLUMNS}, ${CURSOR_AT(sql`c.created_at`)} AS cursor_at FROM library_import_candidates c
      WHERE c.source_entry_id = ${sourceEntryId}::uuid
        ${input.state ? sql`AND c.state = ${input.state}` : sql``}
        ${input.cursor ? sql`AND (c.created_at, c.id) < (${input.cursor.at}::timestamptz, ${input.cursor.id}::uuid)` : sql``}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ${input.limit + 1}
    `);
    return result.rows.map((row) => ({ ...candidateRecord(row), cursorAt: String(row.cursor_at) }));
  }

  /** Tracking proposes given bytes once per lineage: pending, accepted and ignored candidates all count. */
  async hasProposedCandidateForSource(lineageId: string, sourceDigest: string): Promise<boolean> {
    const result = await this.db.execute<{ present: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM library_import_candidates
        WHERE lineage_id = ${lineageId}::uuid AND source_digest = ${sourceDigest} AND state IN ('ready-for-review', 'blocked', 'accepted', 'ignored')
      ) AS present
    `);
    return result.rows[0]?.present === true;
  }

  async transitionCandidate(input: { id: string; from: LibraryCandidateState[]; to: LibraryCandidateState; actorId: string | null; purgeFiles: boolean }): Promise<boolean> {
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE library_import_candidates SET state = ${input.to},
        files = CASE WHEN ${input.purgeFiles} THEN NULL ELSE files END,
        decided_by_user_id = coalesce(${input.actorId}::uuid, decided_by_user_id),
        decided_at = CASE WHEN ${input.actorId}::uuid IS NULL THEN decided_at ELSE now() END,
        updated_at = now()
      WHERE id = ${input.id}::uuid AND state IN (SELECT jsonb_array_elements_text(${JSON.stringify(input.from)}::jsonb))
      RETURNING id
    `);
    return result.rows.length > 0;
  }

  /**
   * Bind a candidate import to the registry submission transaction. The
   * lineage head, source order, held digest and entry state are rechecked
   * under lock; provenance, lineage head and candidate state commit with the
   * version or not at all.
   */
  importBinding(input: {
    candidate: CandidateRecord;
    snapshot: SnapshotRecord;
    source: SourceRecord;
    libraryId: string;
    actorId: string;
    classification: "unclassified" | "reviewed";
    orderAcknowledgement: string | null;
    clientMutationId: string | null;
    now: Date;
    onAccepted: (result: { skillEntryId: string }) => void;
  }): SubmissionImportBinding {
    const candidate = input.candidate;
    return {
      beforeVersionInsert: async (tx, context) => {
        const lineage = (await tx.execute<{ owner_user_id: string; slug: string; revision_counter: number; head_observed_at: unknown }>(sql`
          SELECT owner_user_id, slug, revision_counter, head_observed_at FROM library_import_lineages WHERE id = ${candidate.lineageId}::uuid FOR UPDATE
        `)).rows[0];
        if (!lineage || lineage.owner_user_id !== input.actorId) throw notFound("LIBRARY_CANDIDATE_NOT_FOUND", "Import candidate not found.");
        if (lineage.slug !== candidate.mapping.slug) throw new AppError("The import slug no longer matches its lineage.", "SLUG_CONFLICT", 409);
        if (lineage.revision_counter !== candidate.expectedPriorRevision
          || (lineage.head_observed_at && Date.parse(input.snapshot.observedAt) < Date.parse(iso(lineage.head_observed_at)))) {
          throw new AppError("A newer import revision exists for this skill. Review the current candidate.", "CANDIDATE_SUPERSEDED", 409);
        }
        // Never attach a first import to an existing registry skill; later
        // revisions must continue the lineage owner's own skill.
        if ((lineage.revision_counter === 0 && context.skillId !== null)
          || (lineage.revision_counter > 0 && context.skillOwnerUserId !== input.actorId)) {
          throw new AppError("The import slug is unavailable.", "SLUG_CONFLICT", 409);
        }
        const state = (await tx.execute<{ state: string; package_digest: string | null; expires_at: unknown; held: boolean; entry_status: string; library_status: string }>(sql`
          SELECT c.state, c.package_digest, c.expires_at, c.files IS NOT NULL AS held, e.status AS entry_status, l.status AS library_status
          FROM library_import_candidates c
          JOIN library_entries e ON e.id = c.source_entry_id
          JOIN libraries l ON l.id = e.library_id
          WHERE c.id = ${candidate.id}::uuid
          FOR UPDATE OF c
        `)).rows[0];
        if (!state || state.entry_status !== "active" || state.library_status !== "active") throw notFound("LIBRARY_CANDIDATE_NOT_FOUND", "Import candidate not found.");
        if (state.state === "superseded") throw new AppError("A newer candidate supersedes this one.", "CANDIDATE_SUPERSEDED", 409);
        if (state.state !== "ready-for-review") throw new AppError("The candidate is not importable.", "CANDIDATE_NOT_IMPORTABLE", 409);
        if (!state.held || Date.parse(iso(state.expires_at)) <= input.now.getTime()) throw new AppError("The held preview expired. Preview again.", "PREVIEW_EXPIRED", 409);
        if (state.package_digest !== candidate.packageDigest) throw new AppError("The held preview changed.", "PREVIEW_DIGEST_MISMATCH", 409);
      },
      afterVersionInsert: async (tx, context) => {
        if (context.artifactSha256 !== candidate.packageDigest) {
          throw new AppError("The submitted artifact does not match the held preview.", "PREVIEW_DIGEST_MISMATCH", 409);
        }
        const provenance = candidate.mapping.provenance;
        await tx.execute(sql`
          INSERT INTO skill_release_provenance (skill_version_id, lineage_id, candidate_id, owner_user_id, imported_by_user_id, provider,
            repository_id, repository_full_name, repository_url, ref_kind, ref_value, upstream_label, release_id, commit_sha, tree_sha,
            source_path, native_name, source_digest, package_digest, files, notices, transforms, importer_version, import_profile_digest,
            release_classification, order_acknowledgement, retrieved_at)
          VALUES (${context.versionId}::uuid, ${candidate.lineageId}::uuid, ${candidate.id}::uuid, ${input.actorId}::uuid, ${input.actorId}::uuid,
            'github', ${input.source.repositoryId}, ${input.source.fullName}, ${input.source.htmlUrl}, ${input.snapshot.refKind},
            ${input.snapshot.refValue}, ${input.snapshot.upstreamLabel}, ${input.snapshot.releaseId}, ${input.snapshot.commitSha},
            ${input.snapshot.treeSha}, ${candidate.sourcePath}, ${candidate.nativeName}, ${candidate.sourceDigest}, ${context.artifactSha256},
            ${JSON.stringify((provenance?.files ?? []).filter((file) => file.origin === "upstream"))}::jsonb,
            ${JSON.stringify((provenance?.files ?? []).filter((file) => file.origin === "repository-notice"))}::jsonb,
            ${JSON.stringify(provenance?.transforms ?? candidate.mapping.transforms)}::jsonb,
            ${IMPORTER_VERSION}, ${candidate.profileDigest}, ${input.classification}, ${input.orderAcknowledgement},
            ${input.snapshot.observedAt}::timestamptz)
        `);
        await tx.execute(sql`
          UPDATE library_import_lineages SET revision_counter = revision_counter + 1,
            head_snapshot_id = ${candidate.snapshotId}::uuid, head_observed_at = ${input.snapshot.observedAt}::timestamptz,
            head_candidate_id = ${candidate.id}::uuid, head_source_digest = ${candidate.sourceDigest},
            head_files = ${JSON.stringify(provenance?.headFiles ?? [])}::jsonb,
            mapping_overrides = ${JSON.stringify(candidate.mapping.overrides ?? {})}::jsonb,
            native_name = coalesce(${candidate.nativeName}, native_name), updated_at = now()
          WHERE id = ${candidate.lineageId}::uuid
        `);
        let skillEntryId = (await tx.execute<{ id: string }>(sql`
          SELECT id FROM library_entries
          WHERE library_id = ${input.libraryId}::uuid AND kind = 'skill' AND status = 'active' AND skill_slug = ${candidate.mapping.slug}
          FOR UPDATE
        `)).rows[0]?.id;
        if (skillEntryId) {
          await tx.execute(sql`
            UPDATE library_entries SET lineage_id = coalesce(lineage_id, ${candidate.lineageId}::uuid),
              source_entry_id = coalesce(source_entry_id, ${candidate.sourceEntryId}::uuid), updated_at = now()
            WHERE id = ${skillEntryId}::uuid
          `);
        } else {
          skillEntryId = (await tx.execute<{ id: string }>(sql`
            INSERT INTO library_entries (library_id, kind, title, skill_slug, lineage_id, source_entry_id, created_by_user_id)
            VALUES (${input.libraryId}::uuid, 'skill', ${(candidate.nativeName ?? candidate.mapping.slug).slice(0, 200)}, ${candidate.mapping.slug},
              ${candidate.lineageId}::uuid, ${candidate.sourceEntryId}::uuid, ${input.actorId}::uuid)
            RETURNING id
          `)).rows[0]!.id;
        }
        await tx.execute(sql`
          UPDATE library_import_candidates SET state = 'accepted', submission_id = ${context.versionId}::uuid, skill_entry_id = ${skillEntryId}::uuid,
            decided_by_user_id = ${input.actorId}::uuid, decided_at = now(), accept_client_mutation_id = ${input.clientMutationId},
            order_acknowledgement = ${input.orderAcknowledgement}, updated_at = now()
          WHERE id = ${candidate.id}::uuid AND state = 'ready-for-review'
        `);
        await tx.execute(sql`
          UPDATE library_import_candidates SET state = 'superseded', files = NULL, updated_at = now()
          WHERE lineage_id = ${candidate.lineageId}::uuid AND id <> ${candidate.id}::uuid AND state IN ('ready-for-review', 'blocked')
        `);
        await audit(tx, {
          actorUserId: input.actorId,
          action: "library.candidate.import",
          resourceType: "skill_version",
          resourceId: context.versionId,
          details: { candidateId: candidate.id, slug: candidate.mapping.slug, version: candidate.expectedVersion, packageDigest: context.artifactSha256, classification: input.classification },
        });
        input.onAccepted({ skillEntryId });
      },
    };
  }

  async submissionFacts(submissionIds: string[]): Promise<Map<string, SubmissionFacts>> {
    const ids = submissionIds.filter(isUuid);
    if (ids.length === 0) return new Map();
    const result = await this.db.execute<Row>(sql`
      SELECT v.id, s.slug, v.version, v.review_status::text AS review_status, v.security_status::text AS security_status, v.published_at,
        EXISTS (SELECT 1 FROM skill_version_review_attestations a WHERE a.skill_version_id = v.id AND a.kind = 'private-self-review') AS self_reviewed,
        EXISTS (SELECT 1 FROM skill_version_review_attestations a WHERE a.skill_version_id = v.id AND a.kind = 'instance-elevation') AS elevated,
        r.requested_at
      FROM skill_versions v JOIN skills s ON s.id = v.skill_id
      LEFT JOIN skill_version_elevation_requests r ON r.skill_version_id = v.id
      WHERE v.id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
    `);
    return new Map(result.rows.map((row) => [String(row.id), {
      submissionId: String(row.id),
      slug: String(row.slug),
      version: String(row.version),
      reviewStatus: String(row.review_status) as ReviewStatus,
      securityStatus: String(row.security_status) as SecurityStatus,
      publishedAt: isoOrNull(row.published_at),
      selfReviewed: row.self_reviewed === true,
      elevated: row.elevated === true,
      elevationRequestedAt: isoOrNull(row.requested_at),
    }]));
  }

  // ---- Releases and adoption ---------------------------------------------

  /** Internal facts; callers must first authorize the read through the registry. */
  async releaseFacts(slug: string, version: string): Promise<ReleaseFacts | null> {
    const result = await this.db.execute<Row>(sql`
      SELECT v.id AS skill_version_id, s.id AS skill_id, s.owner_user_id, s.visibility::text AS visibility, a.sha256 AS artifact_sha256,
        EXISTS (SELECT 1 FROM skill_version_review_attestations x WHERE x.skill_version_id = v.id AND x.kind = 'private-self-review') AS self_reviewed,
        EXISTS (SELECT 1 FROM skill_version_review_attestations x WHERE x.skill_version_id = v.id AND x.kind = 'instance-elevation') AS elevated,
        (SELECT p.lineage_id FROM skill_release_provenance p WHERE p.skill_version_id = v.id) AS lineage_id
      FROM skills s JOIN skill_versions v ON v.skill_id = s.id JOIN skill_artifacts a ON a.skill_version_id = v.id
      WHERE s.slug = ${slug} AND v.version = ${version}
    `);
    const row = result.rows[0];
    if (!row) return null;
    return {
      skillVersionId: String(row.skill_version_id),
      skillId: String(row.skill_id),
      ownerUserId: row.owner_user_id === null ? null : String(row.owner_user_id),
      visibility: String(row.visibility) as VisibilityScope,
      artifactSha256: String(row.artifact_sha256),
      selfReviewed: row.self_reviewed === true,
      elevated: row.elevated === true,
      lineageId: row.lineage_id === null ? null : String(row.lineage_id),
    };
  }

  /** Release (or the skill's default release) visible to a team through public/authenticated scope or an explicit team grant. */
  async releaseVisibleToTeam(input: { slug: string; version: string | null; teamId: string; publicEnabled: boolean; authenticatedEnabled: boolean; teamEnabled: boolean }): Promise<boolean> {
    const result = await this.db.execute<{ visible: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM skills s JOIN skill_versions v ON v.skill_id = s.id
        WHERE s.slug = ${input.slug} AND (${input.version}::text IS NULL OR v.version = ${input.version})
          AND s.lifecycle_status IN ('approved', 'deprecated') AND v.lifecycle_status IN ('approved', 'deprecated')
          AND v.review_status = 'approved' AND v.security_status = 'passed' AND v.published_at IS NOT NULL AND v.deleted_at IS NULL
          AND (
            (s.visibility = 'public' AND ${input.publicEnabled})
            OR (s.visibility = 'authenticated' AND ${input.authenticatedEnabled})
            OR (s.visibility = 'team' AND ${input.teamEnabled}
              AND EXISTS (SELECT 1 FROM skill_team_grants g WHERE g.skill_id = s.id AND g.team_id = ${input.teamId}::uuid))
          )
      ) AS visible
    `);
    return result.rows[0]?.visible === true;
  }

  async adopt(input: {
    entryId: string;
    libraryId: string;
    slug: string;
    version: string;
    artifactSha256: string;
    skillVersionId: string;
    attestation: LibraryAttestation;
    expectedCurrentAdoptionId: string | null;
    actorId: string;
    reason: string;
  }): Promise<AdoptionRecord> {
    return this.db.transaction(async (tx) => {
      // Keep the library-before-entry order used by deletion. Authority stays
      // locked until the adoption, event and audit have committed together.
      const library = (await tx.execute<{ owner_user_id: string | null; owner_team_id: string | null }>(sql`
        SELECT owner_user_id, owner_team_id FROM libraries
        WHERE id = ${input.libraryId}::uuid AND status = 'active' FOR UPDATE
      `)).rows[0];
      if (!library) throw notFound("LIBRARY_ENTRY_NOT_FOUND", "Library entry not found.");
      if (library.owner_team_id) {
        // Match team mutations: team, parent organization, organization
        // membership, user, then team membership. Parent locks fence policy
        // and lifecycle changes as well as membership revocation.
        const team = (await tx.execute<{ organization_id: string | null }>(sql`
          SELECT organization_id FROM teams WHERE id = ${library.owner_team_id}::uuid FOR UPDATE
        `)).rows[0];
        if (team?.organization_id) {
          await tx.execute(sql`SELECT id FROM organizations WHERE id = ${team.organization_id}::uuid FOR UPDATE`);
          await tx.execute(sql`
            SELECT id FROM organization_memberships
            WHERE organization_id = ${team.organization_id}::uuid AND user_id = ${input.actorId}::uuid FOR UPDATE
          `);
        }
      }
      const actor = (await tx.execute<{ status: string }>(sql`
        SELECT status FROM users WHERE id = ${input.actorId}::uuid FOR UPDATE
      `)).rows[0];
      let ownsLibrary = library.owner_user_id === input.actorId;
      if (library.owner_team_id) {
        await tx.execute(sql`
          SELECT id FROM team_memberships
          WHERE team_id = ${library.owner_team_id}::uuid AND user_id = ${input.actorId}::uuid FOR UPDATE
        `);
        const authority = (await tx.execute<{ role: string | null }>(sql`
          SELECT ${effectiveTeamRole(sql`${library.owner_team_id}::uuid`, input.actorId)} AS role
        `)).rows[0];
        ownsLibrary = authority?.role === "owner";
      }
      if (!ownsLibrary || actor?.status !== "active") {
        throw new AppError("Library write access is required.", "LIBRARY_WRITE_FORBIDDEN", 403);
      }
      const entry = (await tx.execute<{ current_adoption_id: string | null }>(sql`
        SELECT current_adoption_id FROM library_entries WHERE id = ${input.entryId}::uuid AND library_id = ${input.libraryId}::uuid
          AND skill_slug = ${input.slug} AND status = 'active' AND kind = 'skill' FOR UPDATE
      `)).rows[0];
      if (!entry) throw notFound("LIBRARY_ENTRY_NOT_FOUND", "Library entry not found.");
      if ((entry.current_adoption_id ?? null) !== input.expectedCurrentAdoptionId) {
        throw new AppError("The entry adoption changed. Refresh and retry.", "LIBRARY_ADOPTION_CONFLICT", 409, { currentAdoptionId: entry.current_adoption_id ?? null });
      }
      const inserted = await tx.execute<Row>(sql`
        INSERT INTO library_adoptions (entry_id, library_id, skill_slug, version, artifact_sha256, skill_version_id, attestation,
          predecessor_adoption_id, actor_user_id, reason)
        VALUES (${input.entryId}::uuid, ${input.libraryId}::uuid, ${input.slug}, ${input.version}, ${input.artifactSha256},
          ${input.skillVersionId}::uuid, ${input.attestation}, ${entry.current_adoption_id ?? null}::uuid, ${input.actorId}::uuid, ${input.reason})
        RETURNING *
      `);
      const adoption = adoptionRecord(inserted.rows[0]!);
      await tx.execute(sql`
        UPDATE library_entries SET current_adoption_id = ${adoption.id}::uuid, revision = revision + 1, updated_at = now()
        WHERE id = ${input.entryId}::uuid
      `);
      await insertEvent(tx, {
        libraryId: input.libraryId,
        entryId: input.entryId,
        candidateId: null,
        kind: "adoption-changed",
        audience: "subscribers",
        semanticKey: `adoption:${adoption.id}`,
        version: input.version,
        path: null,
      });
      await audit(tx, { actorUserId: input.actorId, action: "library.entry.adopt", resourceType: "library_entry", resourceId: input.entryId, details: { slug: input.slug, version: input.version, artifactSha256: input.artifactSha256, attestation: input.attestation } });
      return adoption;
    });
  }

  async getAdoption(id: string | null): Promise<AdoptionRecord | null> {
    if (!id || !isUuid(id)) return null;
    const result = await this.db.execute<Row>(sql`SELECT * FROM library_adoptions WHERE id = ${id}::uuid`);
    return result.rows[0] ? adoptionRecord(result.rows[0]) : null;
  }

  async listAdoptions(entryId: string): Promise<AdoptionRecord[]> {
    const result = await this.db.execute<Row>(sql`SELECT * FROM library_adoptions WHERE entry_id = ${entryId}::uuid ORDER BY created_at DESC, id DESC LIMIT 100`);
    return result.rows.map(adoptionRecord);
  }

  // ---- Target bindings ----------------------------------------------------

  async createBinding(input: { entryId: string; libraryId: string; targetId: string; slug: string; actorId: string; detachBindingIds: string[] }): Promise<{ binding: BindingRecord; created: boolean }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`library-binding:${input.targetId}:${input.slug}`}, 0))`);
      if (input.detachBindingIds.length > 0) {
        await tx.execute(sql`
          UPDATE library_target_bindings SET status = 'detached', detached_at = now(), updated_at = now()
          WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(input.detachBindingIds)}::jsonb)::uuid) AND status <> 'detached'
        `);
      }
      const existing = await tx.execute<Row>(sql`
        SELECT * FROM library_target_bindings WHERE entry_id = ${input.entryId}::uuid AND target_id = ${input.targetId}::uuid AND status <> 'detached'
      `);
      if (existing.rows[0]) return { binding: bindingRecord(existing.rows[0]), created: false };
      const inserted = await tx.execute<Row>(sql`
        INSERT INTO library_target_bindings (entry_id, library_id, target_id, skill_slug, status, created_by_user_id)
        VALUES (${input.entryId}::uuid, ${input.libraryId}::uuid, ${input.targetId}::uuid, ${input.slug}, 'active', ${input.actorId}::uuid)
        RETURNING *
      `);
      const binding = bindingRecord(inserted.rows[0]!);
      await audit(tx, { actorUserId: input.actorId, action: "library.binding.create", resourceType: "library_binding", resourceId: binding.id, details: { targetId: input.targetId, slug: input.slug, detached: input.detachBindingIds.length } });
      return { binding, created: true };
    });
  }

  async getBinding(id: string): Promise<BindingRecord | null> {
    if (!isUuid(id)) return null;
    const result = await this.db.execute<Row>(sql`SELECT * FROM library_target_bindings WHERE id = ${id}::uuid`);
    return result.rows[0] ? bindingRecord(result.rows[0]) : null;
  }

  async listBindingsForEntry(entryId: string): Promise<BindingRecord[]> {
    const result = await this.db.execute<Row>(sql`SELECT * FROM library_target_bindings WHERE entry_id = ${entryId}::uuid ORDER BY created_at DESC, id DESC LIMIT 100`);
    return result.rows.map(bindingRecord);
  }

  async detachBinding(id: string, actorId: string): Promise<BindingRecord | null> {
    return this.db.transaction(async (tx) => {
      const updated = await tx.execute<Row>(sql`
        UPDATE library_target_bindings SET status = 'detached', detached_at = now(), updated_at = now()
        WHERE id = ${id}::uuid AND status <> 'detached' RETURNING *
      `);
      if (!updated.rows[0]) return null;
      await audit(tx, { actorUserId: actorId, action: "library.binding.detach", resourceType: "library_binding", resourceId: id, details: {} });
      return bindingRecord(updated.rows[0]);
    });
  }

  async bindingsForTargetSlug(targetId: string, slug: string): Promise<Array<{
    binding: BindingRecord;
    entryActive: boolean;
    libraryActive: boolean;
    library: LibraryRecord | null;
    adoption: { id: string; version: string; artifactSha256: string } | null;
  }>> {
    if (!isUuid(targetId)) return [];
    const result = await this.db.execute<Row>(sql`
      SELECT b.*, e.status AS entry_status, l.status AS library_status,
        l.owner_user_id AS library_owner_user_id, l.owner_team_id AS library_owner_team_id, t.name AS library_owner_team_name,
        l.name AS library_name, l.description AS library_description, l.revision AS library_revision,
        l.created_at AS library_created_at, l.updated_at AS library_updated_at,
        a.id AS adoption_id, a.version AS adoption_version, a.artifact_sha256 AS adoption_sha256
      FROM library_target_bindings b
      JOIN library_entries e ON e.id = b.entry_id
      JOIN libraries l ON l.id = b.library_id
      LEFT JOIN teams t ON t.id = l.owner_team_id
      LEFT JOIN library_adoptions a ON a.id = e.current_adoption_id
      WHERE b.target_id = ${targetId}::uuid AND b.skill_slug = ${slug} AND b.status <> 'detached'
      ORDER BY b.created_at, b.id
    `);
    return result.rows.map((row) => ({
      binding: bindingRecord(row),
      entryActive: row.entry_status === "active",
      libraryActive: row.library_status === "active",
      library: row.library_status === "active" ? libraryRecord({
        id: row.library_id,
        owner_user_id: row.library_owner_user_id,
        owner_team_id: row.library_owner_team_id,
        owner_team_name: row.library_owner_team_name,
        name: row.library_name,
        description: row.library_description,
        revision: row.library_revision,
        created_at: row.library_created_at,
        updated_at: row.library_updated_at,
      }) : null,
      adoption: row.adoption_id ? { id: String(row.adoption_id), version: String(row.adoption_version), artifactSha256: String(row.adoption_sha256) } : null,
    }));
  }

  // ---- Events, subscriptions, inbox --------------------------------------

  /** Check-owned events commit in one transaction while the check holds its lease. Returns the kinds inserted (deduplicated by semantic key). */
  async insertCheckEvents(entryId: string, leaseId: string, events: LibraryEventInput[]): Promise<LibraryEventKind[]> {
    if (events.length === 0) return [];
    return this.db.transaction(async (tx) => {
      if (!await lockEntryForWrite(tx, entryId, leaseId)) throw leaseLostError();
      const inserted: LibraryEventKind[] = [];
      for (const event of events) {
        if (await insertEvent(tx, event)) inserted.push(event.kind);
      }
      return inserted;
    });
  }

  async upsertSubscription(libraryId: string, userId: string, kinds: LibraryEventKind[]): Promise<{ events: LibraryEventKind[]; createdAt: string }> {
    const result = await this.db.execute<{ event_kinds: unknown; created_at: unknown }>(sql`
      INSERT INTO library_subscriptions (library_id, user_id, event_kinds) VALUES (${libraryId}::uuid, ${userId}::uuid, ${JSON.stringify(kinds)}::jsonb)
      ON CONFLICT (library_id, user_id) DO UPDATE SET event_kinds = EXCLUDED.event_kinds, updated_at = now()
      RETURNING event_kinds, created_at
    `);
    const row = result.rows[0]!;
    return { events: stringArray(row.event_kinds) as LibraryEventKind[], createdAt: iso(row.created_at) };
  }

  async deleteSubscription(libraryId: string, userId: string): Promise<void> {
    await this.db.execute(sql`DELETE FROM library_subscriptions WHERE library_id = ${libraryId}::uuid AND user_id = ${userId}::uuid`);
  }

  async getSubscription(libraryId: string, userId: string): Promise<{ events: LibraryEventKind[]; createdAt: string } | null> {
    const result = await this.db.execute<{ event_kinds: unknown; created_at: unknown }>(sql`
      SELECT event_kinds, created_at FROM library_subscriptions WHERE library_id = ${libraryId}::uuid AND user_id = ${userId}::uuid
    `);
    const row = result.rows[0];
    return row ? { events: stringArray(row.event_kinds) as LibraryEventKind[], createdAt: iso(row.created_at) } : null;
  }

  /** One keyset batch; the service filters visibility and continues through hidden rows. */
  async inboxWindow(userId: string, limit: number, cursor: PageCursor | null = null): Promise<InboxRow[]> {
    const result = await this.db.execute<Row>(sql`
      SELECT e.id, e.library_id, l.name AS library_name, e.entry_id, e.candidate_id, e.kind, e.audience, e.version, e.path, e.created_at,
        ${CURSOR_AT(sql`e.created_at`)} AS cursor_at, r.read_at, s.event_kinds
      FROM library_subscriptions s
      JOIN libraries l ON l.id = s.library_id AND l.status = 'active'
      JOIN library_events e ON e.library_id = s.library_id AND e.created_at >= s.created_at
      LEFT JOIN library_inbox_reads r ON r.event_id = e.id AND r.user_id = s.user_id
      WHERE s.user_id = ${userId}::uuid
        ${cursor ? sql`AND (e.created_at, e.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ${limit}
    `);
    return result.rows.map((row) => ({
      id: String(row.id),
      libraryId: String(row.library_id),
      libraryName: String(row.library_name),
      entryId: row.entry_id === null ? null : String(row.entry_id),
      candidateId: row.candidate_id === null ? null : String(row.candidate_id),
      kind: String(row.kind) as LibraryEventKind,
      audience: row.audience === "curators" ? "curators" : "subscribers",
      version: row.version === null ? null : String(row.version),
      path: row.path === null ? null : String(row.path),
      createdAt: iso(row.created_at),
      cursorAt: String(row.cursor_at),
      readAt: isoOrNull(row.read_at),
      subscribedKinds: stringArray(row.event_kinds) as LibraryEventKind[],
    }));
  }

  async markRead(userId: string, eventIds: string[]): Promise<number> {
    const ids = eventIds.filter(isUuid);
    if (ids.length === 0) return 0;
    const result = await this.db.execute<{ event_id: string }>(sql`
      INSERT INTO library_inbox_reads (user_id, event_id)
      SELECT ${userId}::uuid, e.id FROM library_events e
      JOIN library_subscriptions s ON s.library_id = e.library_id AND s.user_id = ${userId}::uuid
      WHERE e.id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
      ON CONFLICT (user_id, event_id) DO NOTHING
      RETURNING event_id
    `);
    return result.rows.length;
  }

  // ---- Tracking leases ----------------------------------------------------

  async claimDueEntries(input: { now: Date; leaseMs: number; limit: number }): Promise<Array<{ entryId: string; leaseId: string }>> {
    const leaseId = randomUUID();
    const now = input.now.toISOString();
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE library_entries SET lease_id = ${leaseId}::uuid,
        lease_expires_at = ${now}::timestamptz + (${input.leaseMs}::double precision * interval '1 millisecond'),
        last_attempt_at = ${now}::timestamptz, updated_at = now()
      WHERE id IN (
        SELECT e.id FROM library_entries e JOIN libraries l ON l.id = e.library_id
        WHERE e.kind = 'source' AND e.status = 'active' AND l.status = 'active' AND l.owner_user_id IS NOT NULL
          AND e.tracking_mode IN ('daily', 'weekly') AND e.next_check_at <= ${now}::timestamptz
          AND e.health NOT IN ('identity-change-review', 'paused') AND e.pending_full_name IS NULL
          AND (e.lease_expires_at IS NULL OR e.lease_expires_at < ${now}::timestamptz)
        ORDER BY e.next_check_at, e.id
        LIMIT ${input.limit}
        FOR UPDATE OF e SKIP LOCKED
      )
      RETURNING id
    `);
    return result.rows.map((row) => ({ entryId: row.id, leaseId }));
  }

  async acquireLease(input: { entryId: string; now: Date; leaseMs: number }): Promise<string | null> {
    const leaseId = randomUUID();
    const now = input.now.toISOString();
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE library_entries SET lease_id = ${leaseId}::uuid,
        lease_expires_at = ${now}::timestamptz + (${input.leaseMs}::double precision * interval '1 millisecond'),
        last_attempt_at = ${now}::timestamptz, updated_at = now()
      WHERE id = ${input.entryId}::uuid AND status = 'active' AND kind = 'source'
        AND (lease_expires_at IS NULL OR lease_expires_at < ${now}::timestamptz)
      RETURNING id
    `);
    return result.rows[0] ? leaseId : null;
  }

  /** Extends a live lease before a check writes; false means another worker may own the entry now. */
  async renewLease(input: { entryId: string; leaseId: string; now: Date; leaseMs: number }): Promise<boolean> {
    const now = input.now.toISOString();
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE library_entries SET lease_expires_at = ${now}::timestamptz + (${input.leaseMs}::double precision * interval '1 millisecond')
      WHERE id = ${input.entryId}::uuid AND status = 'active' AND lease_id = ${input.leaseId}::uuid AND lease_expires_at > ${now}::timestamptz
      RETURNING id
    `);
    return result.rows.length > 0;
  }

  async finishCheck(input: {
    entryId: string;
    leaseId: string;
    health: LibrarySourceHealth;
    lastErrorCode: string | null;
    attemptCount: number;
    nextCheckAt: Date | null;
    succeededAt: Date | null;
    lastGoodSnapshotId: string | null;
    /** Health alerts that commit with the result, or not at all. */
    events?: LibraryEventInput[];
  }): Promise<{ eventKinds: LibraryEventKind[] } | null> {
    // A successful check matched the acknowledged identity, which clears any pending review.
    // A failed one keeps the review visible whatever else went wrong.
    const succeeded = input.succeededAt !== null;
    return this.db.transaction(async (tx) => {
      if (!await lockEntryForWrite(tx, input.entryId, input.leaseId)) return null;
      await tx.execute(sql`
        UPDATE library_entries SET
          health = CASE WHEN pending_full_name IS NOT NULL AND NOT ${succeeded}::boolean THEN 'identity-change-review' ELSE ${input.health} END,
          pending_full_name = CASE WHEN ${succeeded}::boolean THEN NULL ELSE pending_full_name END,
          last_error_code = ${input.lastErrorCode}, attempt_count = ${input.attemptCount},
          next_check_at = CASE WHEN tracking_mode IN ('daily', 'weekly') THEN ${input.nextCheckAt ? input.nextCheckAt.toISOString() : null}::timestamptz ELSE NULL END,
          last_successful_check_at = coalesce(${input.succeededAt ? input.succeededAt.toISOString() : null}::timestamptz, last_successful_check_at),
          last_good_snapshot_id = coalesce(${input.lastGoodSnapshotId}::uuid, last_good_snapshot_id),
          lease_id = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = ${input.entryId}::uuid AND lease_id = ${input.leaseId}::uuid
      `);
      const eventKinds: LibraryEventKind[] = [];
      for (const event of input.events ?? []) {
        if (await insertEvent(tx, event)) eventKinds.push(event.kind);
      }
      return { eventKinds };
    });
  }

  async workerStats(now: Date): Promise<{ overdueTrackCount: number; oldestOverdueCheckAt: string | null }> {
    const result = await this.db.execute<{ overdue: number; oldest: unknown }>(sql`
      SELECT count(*)::int AS overdue, min(next_check_at) AS oldest FROM library_entries
      WHERE kind = 'source' AND status = 'active' AND tracking_mode IN ('daily', 'weekly')
        AND next_check_at < ${now.toISOString()}::timestamptz - interval '1 hour'
    `);
    return { overdueTrackCount: result.rows[0]?.overdue ?? 0, oldestOverdueCheckAt: isoOrNull(result.rows[0]?.oldest) };
  }

  /** Retention: expire held preview bytes and drop old delivery rows. Metadata and provenance stay. */
  async purgeExpired(now: Date): Promise<{ candidatesExpired: number; eventsDeleted: number }> {
    const cutoff = now.toISOString();
    const expired = await this.db.execute<{ id: string }>(sql`
      UPDATE library_import_candidates SET files = NULL,
        state = CASE WHEN state IN ('ready-for-review', 'blocked') THEN 'expired' ELSE state END, updated_at = now()
      WHERE files IS NOT NULL AND expires_at <= ${cutoff}::timestamptz
      RETURNING id
    `);
    const events = await this.db.execute<{ id: string }>(sql`
      DELETE FROM library_events WHERE created_at < ${cutoff}::timestamptz - interval '90 days' RETURNING id
    `);
    return { candidatesExpired: expired.rows.length, eventsDeleted: events.rows.length };
  }

  async recordAudit(input: Parameters<typeof audit>[1]): Promise<void> {
    await audit(this.db, input);
  }
}

export interface SnapshotIdentity {
  entryId: string;
  refKind: LibrarySourceRefKind;
  refValue: string;
  commitSha: string;
  treeSha: string;
  upstreamLabel: string | null;
  releaseId: string | null;
}

/**
 * Only the entry's newest snapshot is reused. An upstream that returns to an
 * older commit gets a new observation, so an acknowledged revert stays newer
 * than the imported head.
 */
async function selectReusableSnapshot(db: Db, input: SnapshotIdentity): Promise<SnapshotRecord | null> {
  const result = await db.execute<Row>(sql`
    SELECT s.id, s.entry_id, s.source_id, s.sequence::int AS sequence, s.ref_kind, s.ref_value, s.resolved_ref, s.upstream_label, s.release_id,
      s.commit_sha, s.tree_sha, s.complete, s.order_status, s.inventory, s.observed_at
    FROM (SELECT * FROM library_source_snapshots WHERE entry_id = ${input.entryId}::uuid ORDER BY sequence DESC LIMIT 1) s
    WHERE s.complete AND s.ref_kind = ${input.refKind} AND s.ref_value = ${input.refValue}
      AND s.commit_sha = ${input.commitSha} AND s.tree_sha = ${input.treeSha}
      AND s.upstream_label IS NOT DISTINCT FROM ${input.upstreamLabel}::text AND s.release_id IS NOT DISTINCT FROM ${input.releaseId}::text
  `);
  return result.rows[0] ? snapshotRecord(result.rows[0]) : null;
}

/**
 * Row lock for a write to an entry's check state. The library row comes first
 * (FOR KEY SHARE), the order library deletion uses, so event inserts that
 * reference the library cannot deadlock with it. The entry takes FOR NO KEY
 * UPDATE: it waits for and blocks lease claims, renewals, finishes, tracking
 * updates and removal, but not the foreign-key checks an import makes when it
 * references this entry while holding its candidate row.
 *
 * With a lease id the lock is the fence. Read committed rechecks the predicate
 * on the newest row version after any wait, so a takeover that committed first
 * makes this return false, and a takeover that starts later waits until this
 * transaction ends. Expiry is not checked: a lease that lapsed but was not
 * claimed still belongs to its check, and renewal (which does check expiry)
 * stops that check at its next phase.
 */
async function lockEntryForWrite(tx: DatabaseTransaction, entryId: string, leaseId: string | null): Promise<boolean> {
  await tx.execute(sql`
    SELECT l.id FROM libraries l JOIN library_entries e ON e.library_id = l.id
    WHERE e.id = ${entryId}::uuid
    FOR KEY SHARE OF l
  `);
  const locked = await tx.execute<{ id: string }>(sql`
    SELECT id FROM library_entries
    WHERE id = ${entryId}::uuid AND status = 'active' ${leaseId ? sql`AND lease_id = ${leaseId}::uuid` : sql``}
    FOR NO KEY UPDATE
  `);
  return locked.rows.length > 0;
}

async function notifyCandidate(tx: DatabaseTransaction, candidate: CandidateRecord, notify: CandidateNotification | null): Promise<LibraryEventKind | null> {
  if (!notify) return null;
  const event = candidateEvent(candidate, notify);
  return await insertEvent(tx, event) ? event.kind : null;
}

async function removeEntryInTransaction(tx: DatabaseTransaction, entryId: string, actorId: string): Promise<RemovalEffects & { trackingStopped: boolean }> {
  const entry = (await tx.execute<{ kind: string; tracking_mode: string; adopted_version: string | null }>(sql`
    SELECT e.kind, e.tracking_mode, a.version AS adopted_version
    FROM library_entries e LEFT JOIN library_adoptions a ON a.id = e.current_adoption_id
    WHERE e.id = ${entryId}::uuid AND e.status = 'active'
    FOR UPDATE OF e
  `)).rows[0];
  if (!entry) throw notFound("LIBRARY_ENTRY_NOT_FOUND", "Library entry not found.");
  await tx.execute(sql`
    UPDATE library_entries SET status = 'removed', removed_at = now(),
      tracking_mode = 'off', next_check_at = NULL, lease_id = NULL, lease_expires_at = NULL,
      health = CASE WHEN kind = 'source' THEN 'not-tracked' ELSE health END,
      revision = revision + 1, updated_at = now()
    WHERE id = ${entryId}::uuid
  `);
  // Keep the last adopted pin; never fall back to registry latest.
  const bindings = await tx.execute<{ id: string }>(sql`
    UPDATE library_target_bindings SET status = 'curation-unavailable', pinned_version = coalesce(${entry.adopted_version}, pinned_version), updated_at = now()
    WHERE entry_id = ${entryId}::uuid AND status = 'active'
    RETURNING id
  `);
  const candidates = await tx.execute<{ id: string }>(sql`
    UPDATE library_import_candidates SET state = 'ignored', files = NULL, decided_by_user_id = ${actorId}::uuid, decided_at = now(), updated_at = now()
    WHERE source_entry_id = ${entryId}::uuid AND state IN ('ready-for-review', 'blocked')
    RETURNING id
  `);
  await audit(tx, {
    actorUserId: actorId,
    action: "library.entry.remove",
    resourceType: "library_entry",
    resourceId: entryId,
    details: { bindings: bindings.rows.length, candidates: candidates.rows.length },
  });
  return {
    entriesRemoved: 1,
    subscriptionsEnded: 0,
    bindingsMarkedCurationUnavailable: bindings.rows.length,
    candidatesCancelled: candidates.rows.length,
    trackingStopped: entry.kind === "source" && entry.tracking_mode !== "off",
  };
}

async function insertEvent(db: Db, input: LibraryEventInput): Promise<boolean> {
  // Upstream paths can exceed the stored bounds. Long keys keep a digest of the whole key so
  // distinct events never collide; long display paths are shortened with a visible ellipsis.
  const semanticKey = input.semanticKey.length <= 400
    ? input.semanticKey
    : `${input.semanticKey.slice(0, 335)}#${createHash("sha256").update(input.semanticKey).digest("hex")}`;
  const path = input.path !== null && input.path.length > 1024 ? `${input.path.slice(0, 1023)}…` : input.path;
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO library_events (library_id, entry_id, candidate_id, kind, audience, semantic_key, version, path)
    VALUES (${input.libraryId}::uuid, ${input.entryId}::uuid, ${input.candidateId}::uuid, ${input.kind}, ${input.audience},
      ${semanticKey}, ${input.version}, ${path})
    ON CONFLICT ON CONSTRAINT library_events_semantic_key_unique DO NOTHING
    RETURNING id
  `);
  return result.rows.length > 0;
}

async function audit(db: Db, input: {
  actorUserId: string | null;
  action: string;
  decision?: "allow" | "deny";
  resourceType: string;
  resourceId?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_events (actor_user_id, action, decision, resource_type, resource_id, details)
    VALUES (${input.actorUserId}::uuid, ${input.action}, ${input.decision ?? "allow"}, ${input.resourceType},
      ${input.resourceId && isUuid(input.resourceId) ? input.resourceId : null}::uuid,
      ${JSON.stringify(sanitizeAuditDetails(input.details ?? {}))}::jsonb)
  `);
}

async function replayMutation(tx: DatabaseTransaction, table: SQL, actorId: string, clientMutationId: string, digest: string): Promise<string | null> {
  const result = await tx.execute<{ id: string; client_mutation_digest: string | null }>(sql`
    SELECT id, client_mutation_digest FROM ${table} WHERE created_by_user_id = ${actorId}::uuid AND client_mutation_id = ${clientMutationId}
  `);
  const row = result.rows[0];
  if (!row) return null;
  if (row.client_mutation_digest !== digest) {
    throw new AppError("The client mutation id was already used for a different request.", "CLIENT_MUTATION_ID_CONFLICT", 409);
  }
  return row.id;
}

function libraryRecord(row: Row): LibraryRecord {
  return {
    id: String(row.id),
    ownerUserId: row.owner_user_id === null || row.owner_user_id === undefined ? null : String(row.owner_user_id),
    ownerTeamId: row.owner_team_id === null || row.owner_team_id === undefined ? null : String(row.owner_team_id),
    ownerTeamName: row.owner_team_name === null || row.owner_team_name === undefined ? null : String(row.owner_team_name),
    name: String(row.name),
    description: String(row.description ?? ""),
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function sourceRecord(row: Row): SourceRecord {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    fullName: String(row.full_name),
    htmlUrl: String(row.html_url),
    defaultBranch: row.default_branch === null ? null : String(row.default_branch),
    licenseSpdx: row.license_spdx === null ? null : String(row.license_spdx),
    archived: row.archived === true,
  };
}

function entryRecord(row: Row): EntryRecord {
  return {
    id: String(row.id),
    libraryId: String(row.library_id),
    kind: row.kind === "skill" ? "skill" : "source",
    revision: Number(row.revision),
    title: String(row.title),
    sourceId: nullableString(row.source_id),
    sourcePath: String(row.source_path ?? ""),
    refKind: nullableString(row.ref_kind) as LibrarySourceRefKind | null,
    refValue: String(row.ref_value ?? ""),
    acknowledgedFullName: nullableString(row.acknowledged_full_name),
    pendingFullName: nullableString(row.pending_full_name),
    trackingMode: String(row.tracking_mode) as LibraryTrackingMode,
    health: String(row.health) as LibrarySourceHealth,
    nextCheckAt: isoOrNull(row.next_check_at),
    lastAttemptAt: isoOrNull(row.last_attempt_at),
    lastSuccessfulCheckAt: isoOrNull(row.last_successful_check_at),
    lastErrorCode: nullableString(row.last_error_code),
    attemptCount: Number(row.attempt_count ?? 0),
    leaseId: nullableString(row.lease_id),
    lastGoodSnapshotId: nullableString(row.last_good_snapshot_id),
    skillSlug: nullableString(row.skill_slug),
    lineageId: nullableString(row.lineage_id),
    sourceEntryId: nullableString(row.source_entry_id),
    currentAdoptionId: nullableString(row.current_adoption_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function snapshotRecord(row: Row): SnapshotRecord {
  return {
    id: String(row.id),
    entryId: String(row.entry_id),
    sourceId: String(row.source_id),
    sequence: Number(row.sequence),
    refKind: String(row.ref_kind) as LibrarySourceRefKind,
    refValue: String(row.ref_value ?? ""),
    resolvedRef: nullableString(row.resolved_ref),
    upstreamLabel: nullableString(row.upstream_label),
    releaseId: nullableString(row.release_id),
    commitSha: String(row.commit_sha),
    treeSha: String(row.tree_sha),
    complete: row.complete === true,
    orderStatus: String(row.order_status) as SnapshotRecord["orderStatus"],
    inventory: Array.isArray(row.inventory) ? row.inventory as SourceTreeEntry[] : [],
    observedAt: iso(row.observed_at),
  };
}

function lineageRecord(row: Row): LineageRecord {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    sourceId: String(row.source_id),
    sourcePath: String(row.source_path ?? ""),
    refKind: String(row.ref_kind) as LibrarySourceRefKind,
    refValue: String(row.ref_value ?? ""),
    nativeName: nullableString(row.native_name),
    slug: String(row.slug),
    revisionCounter: Number(row.revision_counter ?? 0),
    headSnapshotId: nullableString(row.head_snapshot_id),
    headObservedAt: isoOrNull(row.head_observed_at),
    headSourceDigest: nullableString(row.head_source_digest),
    headFiles: Array.isArray(row.head_files) ? row.head_files as Array<{ path: string; gitBlobSha: string }> : [],
    mappingOverrides: isRecord(row.mapping_overrides) ? row.mapping_overrides as MappingOverrides : {},
  };
}

function candidateRecord(row: Row): CandidateRecord {
  return {
    id: String(row.id),
    sourceEntryId: String(row.source_entry_id),
    skillEntryId: nullableString(row.skill_entry_id),
    lineageId: String(row.lineage_id),
    ownerUserId: String(row.owner_user_id),
    snapshotId: String(row.snapshot_id),
    previewId: nullableString(row.preview_id),
    origin: row.origin === "tracking" ? "tracking" : "preview",
    state: String(row.state) as LibraryCandidateState,
    sourcePath: String(row.source_path ?? ""),
    nativeName: nullableString(row.native_name),
    profileDigest: String(row.profile_digest),
    expectedPriorRevision: Number(row.expected_prior_revision),
    expectedVersion: String(row.expected_version),
    orderStatus: String(row.order_status) as CandidateRecord["orderStatus"],
    sourceDigest: String(row.source_digest),
    packageDigest: nullableString(row.package_digest),
    files: Array.isArray(row.files) ? row.files as HeldFile[] : null,
    fileDigests: Array.isArray(row.file_digests) ? row.file_digests as LibraryCandidateFile[] : [],
    mapping: row.mapping as CandidateRecord["mapping"],
    findings: Array.isArray(row.findings) ? row.findings as LibraryFinding[] : [],
    changes: isRecord(row.changes) ? row.changes as CandidateRecord["changes"] : null,
    submissionId: nullableString(row.submission_id),
    orderAcknowledgement: nullableString(row.order_acknowledgement),
    expiresAt: iso(row.expires_at),
    decidedAt: isoOrNull(row.decided_at),
    createdAt: iso(row.created_at),
  };
}

function adoptionRecord(row: Row): AdoptionRecord {
  return {
    id: String(row.id),
    entryId: String(row.entry_id),
    libraryId: String(row.library_id),
    slug: String(row.skill_slug),
    version: String(row.version),
    artifactSha256: String(row.artifact_sha256),
    skillVersionId: String(row.skill_version_id),
    attestation: row.attestation === "private-self-reviewed" ? "private-self-reviewed" : "instance-reviewed",
    predecessorAdoptionId: nullableString(row.predecessor_adoption_id),
    actorUserId: String(row.actor_user_id),
    reason: String(row.reason ?? ""),
    createdAt: iso(row.created_at),
  };
}

function bindingRecord(row: Row): BindingRecord {
  const status = String(row.status);
  return {
    id: String(row.id),
    entryId: String(row.entry_id),
    libraryId: String(row.library_id),
    targetId: String(row.target_id),
    slug: String(row.skill_slug),
    status: status === "detached" ? "detached" : status === "curation-unavailable" ? "curation-unavailable" : "active",
    pinnedVersion: nullableString(row.pinned_version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isUuid(input: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input);
}

function notFound(code: string, message: string): AppError {
  return new AppError(message, code, 404);
}

function revisionConflict(currentRevision: number): AppError {
  return new AppError("The library changed. Refresh and retry.", "LIBRARY_REVISION_CONFLICT", 409, { currentRevision });
}
