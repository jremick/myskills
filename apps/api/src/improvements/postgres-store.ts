import { sql, type SQL } from "drizzle-orm";
import type { ImprovementScopeRef } from "@myskills-app/core";
import type { Database } from "../db/client.js";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type { PostgresReleasePublicationGuard } from "../submissions/postgres-submission-store.js";
import type { ReleasePublicationCandidate } from "../submissions/types.js";
import {
  declarationPublicationBlocker,
  declarationReviewed,
  declarationStale,
  evidenceReviewed,
  improvementNotFound,
  releaseStateChanged,
  revisionConflict,
  runActive,
  runConflict,
  scopeForbidden,
  type DeclarationReviewRecord,
  type DeclarationRevisionRecord,
  type DocumentRecord,
  type DocumentRevisionRecord,
  type EvidenceAcceptanceRecord,
  type EvidenceRecord,
  type ImprovementAuditInput,
  type ImprovementDocumentKind,
  type ImprovementScopeAuthority,
  type ImprovementStore,
  type PlanRecord,
  type PolicyRevisionRecord,
  type RunEventRecord,
  type RunMutation,
  type RunRecord,
  type SkillGovernance,
} from "./types.js";

type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];
type Row = Record<string, unknown>;

/**
 * Postgres persistence for skill improvement. Revisions, events, evidence, and decisions are
 * append-only (enforced by triggers); runs use compare-and-set versions. Team and organization
 * write authority is rechecked inside the same transaction as the write. Declaration writes and
 * publication serialize on the release's skill_versions row.
 */
export class PostgresImprovementStore implements ImprovementStore, PostgresReleasePublicationGuard {
  readonly kind = "postgres" as const;

  constructor(private readonly db: Database) {}

  /** Publication guard: runs in the publication transaction, which already holds the release row lock. */
  async assertReleasePublishable(executor: Executor, release: ReleasePublicationCandidate): Promise<void> {
    const revisions = (await rows(executor, declarationQuery(sql`r.release_id = ${release.releaseId}::uuid AND r.kind = 'declaration'`))).map(declarationRow);
    const blocker = declarationPublicationBlocker(revisions, release);
    if (blocker) throw blocker;
  }

  async recordAudit(input: ImprovementAuditInput): Promise<void> {
    await insertAudit(this.db, input);
  }

  async getSkillGovernance(slug: string): Promise<SkillGovernance | null> {
    const skill = await rows(this.db, sql`SELECT visibility::text AS visibility FROM skills WHERE slug = ${slug} LIMIT 1`);
    if (!skill[0]) return null;
    const organizations = await rows(this.db, sql`
      SELECT g.organization_id::text AS organization_id
      FROM skill_organization_grants g
      JOIN skills s ON s.id = g.skill_id
      JOIN organizations o ON o.id = g.organization_id
      WHERE s.slug = ${slug} AND o.status = 'active'
      ORDER BY g.organization_id`);
    const teams = await rows(this.db, sql`
      SELECT t.id::text AS id, t.organization_id::text AS organization_id
      FROM skill_team_grants g
      JOIN skills s ON s.id = g.skill_id
      JOIN teams t ON t.id = g.team_id
      LEFT JOIN organizations o ON o.id = t.organization_id
      WHERE s.slug = ${slug} AND (t.organization_id IS NULL OR o.status = 'active')
      ORDER BY t.id`);
    return {
      visibility: String(skill[0].visibility),
      organizationIds: organizations.map((row) => String(row.organization_id)),
      teams: teams.map((row) => ({ id: String(row.id), organizationId: row.organization_id === null ? null : String(row.organization_id) })),
    };
  }

  async listDeclarationRevisions(releaseId: string): Promise<DeclarationRevisionRecord[]> {
    return (await rows(this.db, declarationQuery(sql`r.release_id = ${releaseId}::uuid`))).map(declarationRow);
  }

  async appendDeclarationRevision(input: Parameters<ImprovementStore["appendDeclarationRevision"]>[0]): Promise<{ revision: DeclarationRevisionRecord; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const release = await lockRelease(tx, input.revision.releaseId);
      const existing = (await rows(tx, declarationQuery(sql`r.release_id = ${input.revision.releaseId}::uuid`))).map(declarationRow);
      const latest = existing[existing.length - 1];
      const latestNumber = latest?.revisionNumber ?? 0;
      if (latest && latest.declarationSha256 === input.revision.declarationSha256 && latest.kind === input.revision.kind
        && input.expectedRevisionNumber === latestNumber - 1) {
        return { revision: latest, created: false };
      }
      // The service chose the kind from an earlier read; publication may have committed since.
      if (input.revision.kind !== (release.published ? "attestation" : "declaration")) throw releaseStateChanged();
      if (latestNumber !== input.expectedRevisionNumber) throw revisionConflict(latestNumber);
      const revision = input.revision;
      await tx.execute(sql`
        INSERT INTO improvement_declaration_revisions
          (id, release_id, skill_slug, version, revision_number, kind, declaration, declaration_sha256, reason, created_by_user_id, created_at)
        VALUES (${revision.id}::uuid, ${revision.releaseId}::uuid, ${revision.slug}, ${revision.version}, ${latestNumber + 1}, ${revision.kind},
          ${json(revision.declaration)}::jsonb, ${revision.declarationSha256}, ${revision.reason}, ${revision.createdByUserId}::uuid, ${revision.createdAt}::timestamptz)`);
      await insertAudit(tx, { ...input.audit, resourceId: revision.id, details: { ...input.audit.details, revisionNumber: latestNumber + 1 } });
      return { revision: { ...revision, revisionNumber: latestNumber + 1, review: null }, created: true };
    });
  }

  async reviewDeclarationRevision(input: Parameters<ImprovementStore["reviewDeclarationRevision"]>[0]): Promise<DeclarationRevisionRecord> {
    return this.db.transaction(async (tx) => {
      await lockRelease(tx, input.releaseId);
      const revisions = (await rows(tx, declarationQuery(sql`r.release_id = ${input.releaseId}::uuid`))).map(declarationRow);
      const revision = revisions.find((item) => item.id === input.revisionId);
      if (!revision) throw improvementNotFound();
      if (revision.review) throw declarationReviewed();
      if (revisions.some((item) => item.kind === revision.kind && item.revisionNumber > revision.revisionNumber)) throw declarationStale();
      const review = input.review;
      await tx.execute(sql`
        INSERT INTO improvement_declaration_reviews (revision_id, decision, binding_sha256, artifact_sha256, reviewer_user_id, reason, created_at)
        VALUES (${revision.id}::uuid, ${review.decision}, ${review.bindingSha256}, ${review.artifactSha256}, ${review.reviewerUserId}::uuid,
          ${review.reason}, ${review.createdAt}::timestamptz)`);
      await insertAudit(tx, input.audit);
      return { ...revision, review };
    });
  }

  async getLatestPolicy(scope: ImprovementScopeRef): Promise<PolicyRevisionRecord | null> {
    if (!isUuid(scope.id)) return null;
    const [row] = await rows(this.db, sql`
      SELECT * FROM improvement_policy_revisions
      WHERE scope_type = ${scope.type} AND scope_id = ${scope.id}::uuid
      ORDER BY revision_number DESC LIMIT 1`);
    return row ? policyRow(row) : null;
  }

  async appendPolicyRevision(input: Parameters<ImprovementStore["appendPolicyRevision"]>[0]): Promise<{ revision: PolicyRevisionRecord; created: boolean }> {
    return this.db.transaction(async (tx) => {
      await assertScopeWriter(tx, input.authority);
      const scope = input.revision.scope;
      await advisoryLock(tx, `improvement-policy:${scope.type}:${scope.id}`);
      const [latestRow] = await rows(tx, sql`
        SELECT * FROM improvement_policy_revisions
        WHERE scope_type = ${scope.type} AND scope_id = ${scope.id}::uuid
        ORDER BY revision_number DESC LIMIT 1`);
      const latest = latestRow ? policyRow(latestRow) : null;
      const latestNumber = latest?.revisionNumber ?? 0;
      if (latestNumber !== input.expectedRevisionNumber) throw revisionConflict(latestNumber);
      if (latest?.policySha256 === input.revision.policySha256) return { revision: latest, created: false };
      const revision = input.revision;
      await tx.execute(sql`
        INSERT INTO improvement_policy_revisions
          (id, scope_type, scope_id, revision_number, policy, policy_sha256, reason, created_by_user_id, created_at)
        VALUES (${revision.id}::uuid, ${scope.type}, ${scope.id}::uuid, ${latestNumber + 1}, ${json(revision.policy)}::jsonb,
          ${revision.policySha256}, ${revision.reason}, ${revision.createdByUserId}::uuid, ${revision.createdAt}::timestamptz)`);
      await insertAudit(tx, { ...input.audit, resourceId: revision.id, details: { ...input.audit.details, revisionNumber: latestNumber + 1 } });
      return { revision: { ...revision, revisionNumber: latestNumber + 1 }, created: true };
    });
  }

  async listDocuments(kind: ImprovementDocumentKind, owner: ImprovementScopeRef): Promise<DocumentRecord[]> {
    if (!isUuid(owner.id)) return [];
    const documents = await rows(this.db, sql`
      SELECT * FROM improvement_documents
      WHERE kind = ${kind} AND owner_type = ${owner.type} AND owner_id = ${owner.id}::uuid
      ORDER BY created_at, id`);
    return Promise.all(documents.map((row) => this.withRevisions(this.db, row)));
  }

  async getDocument(id: string): Promise<DocumentRecord | null> {
    if (!isUuid(id)) return null;
    const [row] = await rows(this.db, sql`SELECT * FROM improvement_documents WHERE id = ${id}::uuid`);
    return row ? this.withRevisions(this.db, row) : null;
  }

  async getDocumentByRevision(revisionId: string): Promise<DocumentRecord | null> {
    if (!isUuid(revisionId)) return null;
    const [row] = await rows(this.db, sql`
      SELECT d.* FROM improvement_documents d
      JOIN improvement_document_revisions r ON r.document_id = d.id
      WHERE r.id = ${revisionId}::uuid`);
    return row ? this.withRevisions(this.db, row) : null;
  }

  async createDocument(input: Parameters<ImprovementStore["createDocument"]>[0]): Promise<DocumentRecord> {
    return this.db.transaction(async (tx) => {
      await assertScopeWriter(tx, input.authority);
      const document = input.document;
      const revision = input.revision;
      await tx.execute(sql`
        INSERT INTO improvement_documents (id, kind, owner_type, owner_id, created_by_user_id, created_at)
        VALUES (${document.id}::uuid, ${document.kind}, ${document.owner.type}, ${document.owner.id}::uuid,
          ${document.createdByUserId}::uuid, ${document.createdAt}::timestamptz)`);
      await insertDocumentRevision(tx, document.id, 1, revision);
      await insertAudit(tx, { ...input.audit, resourceId: document.id });
      const stored = { ...revision, revisionNumber: 1 };
      return { ...document, latest: stored, revisions: [stored] };
    });
  }

  async appendDocumentRevision(input: Parameters<ImprovementStore["appendDocumentRevision"]>[0]): Promise<{ document: DocumentRecord; created: boolean }> {
    return this.db.transaction(async (tx) => {
      await assertScopeWriter(tx, input.authority);
      await advisoryLock(tx, `improvement-document:${input.documentId}`);
      const [row] = await rows(tx, sql`SELECT * FROM improvement_documents WHERE id = ${input.documentId}::uuid`);
      if (!row) throw improvementNotFound();
      const document = await this.withRevisions(tx, row);
      if (document.latest.revisionNumber !== input.expectedRevisionNumber) throw revisionConflict(document.latest.revisionNumber);
      if (document.latest.bodySha256 === input.revision.bodySha256) return { document, created: false };
      const revisionNumber = document.latest.revisionNumber + 1;
      await insertDocumentRevision(tx, document.id, revisionNumber, input.revision);
      await insertAudit(tx, { ...input.audit, resourceId: document.id, details: { ...input.audit.details, revisionNumber } });
      const stored = { ...input.revision, revisionNumber };
      return { document: { ...document, latest: stored, revisions: [...document.revisions, stored] }, created: true };
    });
  }

  async findPlanByIdempotencyKey(actorUserId: string, idempotencyKey: string): Promise<PlanRecord | null> {
    if (!isUuid(actorUserId)) return null;
    const [row] = await rows(this.db, sql`
      SELECT * FROM improvement_plans WHERE actor_user_id = ${actorUserId}::uuid AND idempotency_key = ${idempotencyKey}`);
    return row ? planRow(row) : null;
  }

  async createPlan(input: Parameters<ImprovementStore["createPlan"]>[0]): Promise<{ plan: PlanRecord; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const plan = input.plan;
      const inserted = await rows(tx, sql`
        INSERT INTO improvement_plans
          (id, actor_user_id, idempotency_key, request_sha256, request, plan_sha256, plan, effective_policy, created_at, expires_at)
        VALUES (${plan.id}::uuid, ${plan.actorUserId}::uuid, ${plan.idempotencyKey}, ${plan.requestSha256}, ${json(plan.request)}::jsonb,
          ${plan.planSha256}, ${json(plan.plan)}::jsonb, ${json(plan.effectivePolicy)}::jsonb, ${plan.createdAt}::timestamptz, ${plan.expiresAt}::timestamptz)
        ON CONFLICT (actor_user_id, idempotency_key) DO NOTHING
        RETURNING id`);
      if (!inserted[0]) {
        const [existing] = await rows(tx, sql`
          SELECT * FROM improvement_plans WHERE actor_user_id = ${plan.actorUserId}::uuid AND idempotency_key = ${plan.idempotencyKey}`);
        if (!existing) throw runConflict();
        return { plan: planRow(existing), created: false };
      }
      await insertAudit(tx, input.audit);
      return { plan, created: true };
    });
  }

  async getPlan(id: string): Promise<PlanRecord | null> {
    if (!isUuid(id)) return null;
    const [row] = await rows(this.db, sql`SELECT * FROM improvement_plans WHERE id = ${id}::uuid`);
    return row ? planRow(row) : null;
  }

  async listRunsForPlan(planId: string): Promise<RunRecord[]> {
    if (!isUuid(planId)) return [];
    return (await rows(this.db, sql`SELECT * FROM improvement_runs WHERE plan_id = ${planId}::uuid ORDER BY attempt`)).map(runRow);
  }

  async createRun(input: Parameters<ImprovementStore["createRun"]>[0]): Promise<{ run: RunRecord; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const run = input.run;
      const [plan] = await rows(tx, sql`SELECT id FROM improvement_plans WHERE id = ${run.planId}::uuid FOR UPDATE`);
      if (!plan) throw improvementNotFound();
      const existing = (await rows(tx, sql`SELECT * FROM improvement_runs WHERE plan_id = ${run.planId}::uuid ORDER BY attempt`)).map(runRow);
      const replay = existing.find((item) => item.idempotencyKey === run.idempotencyKey);
      if (replay) return { run: replay, created: false };
      if (existing.some((item) => item.progress.state === "running")) throw runActive();
      if (existing.some((item) => item.attempt === run.attempt)) throw runConflict();
      await tx.execute(sql`
        INSERT INTO improvement_runs
          (id, plan_id, plan_sha256, actor_user_id, attempt, idempotency_key, runner_sha256, runner, state, progress,
           last_sequence, version, cancellation, created_at, updated_at, completed_at)
        VALUES (${run.id}::uuid, ${run.planId}::uuid, ${run.planSha256}, ${run.actorUserId}::uuid, ${run.attempt}, ${run.idempotencyKey},
          ${run.runnerSha256}, ${json(run.runner)}::jsonb, ${run.progress.state}, ${json(run.progress)}::jsonb,
          ${run.lastSequence}, ${run.version}, ${run.cancellation}, ${run.createdAt}::timestamptz, ${run.updatedAt}::timestamptz,
          ${run.completedAt}::timestamptz)`);
      await insertAudit(tx, input.audit);
      return { run, created: true };
    });
  }

  async getRun(id: string): Promise<RunRecord | null> {
    if (!isUuid(id)) return null;
    const [row] = await rows(this.db, sql`SELECT * FROM improvement_runs WHERE id = ${id}::uuid`);
    return row ? runRow(row) : null;
  }

  async listRunEvents(runId: string): Promise<RunEventRecord[]> {
    if (!isUuid(runId)) return [];
    return (await rows(this.db, sql`SELECT * FROM improvement_run_events WHERE run_id = ${runId}::uuid ORDER BY sequence`)).map(eventRow);
  }

  async appendRunEvent(input: Parameters<ImprovementStore["appendRunEvent"]>[0]): Promise<RunRecord> {
    return this.db.transaction(async (tx) => {
      await lockRunVersion(tx, input.runId, input.expectedVersion);
      const [duplicate] = await rows(tx, sql`
        SELECT 1 AS present FROM improvement_run_events WHERE run_id = ${input.runId}::uuid AND sequence = ${input.event.sequence}`);
      if (duplicate) throw runConflict();
      const event = input.event;
      await tx.execute(sql`
        INSERT INTO improvement_run_events (id, run_id, sequence, type, event, event_sha256, created_at)
        VALUES (${event.id}::uuid, ${event.runId}::uuid, ${event.sequence}, ${event.type}, ${json(event.event)}::jsonb,
          ${event.eventSha256}, ${event.createdAt}::timestamptz)`);
      const updated = await updateRunRow(tx, input.runId, input.expectedVersion, input.next);
      await insertAudit(tx, input.audit);
      return updated;
    });
  }

  async updateRun(input: Parameters<ImprovementStore["updateRun"]>[0]): Promise<RunRecord> {
    return this.db.transaction(async (tx) => {
      await lockRunVersion(tx, input.runId, input.expectedVersion);
      const updated = await updateRunRow(tx, input.runId, input.expectedVersion, input.next);
      await insertAudit(tx, input.audit);
      return updated;
    });
  }

  async findEvidenceByIdempotencyKey(reporterUserId: string, idempotencyKey: string): Promise<EvidenceRecord | null> {
    if (!isUuid(reporterUserId)) return null;
    const [row] = await rows(this.db, sql`
      SELECT * FROM improvement_evidence WHERE reporter_user_id = ${reporterUserId}::uuid AND idempotency_key = ${idempotencyKey}`);
    return row ? evidenceRow(row) : null;
  }

  async createEvidence(input: Parameters<ImprovementStore["createEvidence"]>[0]): Promise<{ evidence: EvidenceRecord; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const evidence = input.evidence;
      const inserted = await rows(tx, sql`
        INSERT INTO improvement_evidence
          (id, run_id, plan_id, reporter_user_id, context, idempotency_key, request_sha256, disclosure, provenance, summary,
           evidence_sha256, proposals, created_at)
        VALUES (${evidence.id}::uuid, ${evidence.runId}::uuid, ${evidence.planId}::uuid, ${evidence.reporterUserId}::uuid,
          ${json(evidence.context)}::jsonb, ${evidence.idempotencyKey}, ${evidence.requestSha256}, ${evidence.disclosure},
          ${evidence.provenance}, ${json(evidence.summary)}::jsonb, ${evidence.evidenceSha256}, ${json(evidence.proposals)}::jsonb,
          ${evidence.createdAt}::timestamptz)
        ON CONFLICT (reporter_user_id, idempotency_key) DO NOTHING
        RETURNING id`);
      if (!inserted[0]) {
        const [existing] = await rows(tx, sql`
          SELECT * FROM improvement_evidence WHERE reporter_user_id = ${evidence.reporterUserId}::uuid AND idempotency_key = ${evidence.idempotencyKey}`);
        if (!existing) throw runConflict();
        return { evidence: evidenceRow(existing), created: false };
      }
      await insertAudit(tx, input.audit);
      return { evidence, created: true };
    });
  }

  async getEvidence(id: string): Promise<EvidenceRecord | null> {
    if (!isUuid(id)) return null;
    const [row] = await rows(this.db, sql`SELECT * FROM improvement_evidence WHERE id = ${id}::uuid`);
    return row ? evidenceRow(row) : null;
  }

  async listEvidenceProposedForRelease(releaseId: string): Promise<EvidenceRecord[]> {
    if (!isUuid(releaseId)) return [];
    return (await rows(this.db, sql`
      SELECT * FROM improvement_evidence
      WHERE proposals @> ${json([{ releaseId }])}::jsonb
      ORDER BY created_at, id`)).map(evidenceRow);
  }

  async listAcceptances(input: { evidenceId?: string; releaseId?: string }): Promise<EvidenceAcceptanceRecord[]> {
    const conditions: SQL[] = [];
    if (input.evidenceId !== undefined) {
      if (!isUuid(input.evidenceId)) return [];
      conditions.push(sql`evidence_id = ${input.evidenceId}::uuid`);
    }
    if (input.releaseId !== undefined) {
      if (!isUuid(input.releaseId)) return [];
      conditions.push(sql`release_id = ${input.releaseId}::uuid`);
    }
    const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
    return (await rows(this.db, sql`SELECT * FROM improvement_evidence_acceptances ${where} ORDER BY created_at, id`)).map(acceptanceRow);
  }

  async createAcceptance(input: Parameters<ImprovementStore["createAcceptance"]>[0]): Promise<EvidenceAcceptanceRecord> {
    return this.db.transaction(async (tx) => {
      const acceptance = input.acceptance;
      const inserted = await rows(tx, sql`
        INSERT INTO improvement_evidence_acceptances
          (id, evidence_id, release_id, subject, evidence_sha256, decision, provenance, actor_user_id, reason, created_at)
        VALUES (${acceptance.id}::uuid, ${acceptance.evidenceId}::uuid, ${acceptance.releaseId}::uuid, ${acceptance.subject},
          ${acceptance.evidenceSha256}, ${acceptance.decision}, ${acceptance.provenance}, ${acceptance.actorUserId}::uuid,
          ${acceptance.reason}, ${acceptance.createdAt}::timestamptz)
        ON CONFLICT (evidence_id, release_id, subject) DO NOTHING
        RETURNING id`);
      if (!inserted[0]) throw evidenceReviewed();
      await insertAudit(tx, input.audit);
      return acceptance;
    });
  }

  private async withRevisions(executor: Executor, row: Row): Promise<DocumentRecord> {
    const revisions = (await rows(executor, sql`
      SELECT * FROM improvement_document_revisions WHERE document_id = ${String(row.id)}::uuid ORDER BY revision_number`)).map(documentRevisionRow);
    const latest = revisions[revisions.length - 1];
    if (!latest) throw improvementNotFound();
    return {
      id: String(row.id),
      kind: String(row.kind) as ImprovementDocumentKind,
      owner: { type: String(row.owner_type) as ImprovementScopeRef["type"], id: String(row.owner_id) },
      createdByUserId: String(row.created_by_user_id),
      createdAt: iso(row.created_at),
      latest,
      revisions,
    };
  }
}

async function rows(executor: Executor, query: SQL): Promise<Row[]> {
  const result = await executor.execute(query);
  return result.rows as Row[];
}

async function advisoryLock(executor: Executor, key: string): Promise<void> {
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/**
 * Serializes declaration writes with each other and with publication, which holds FOR UPDATE on
 * the same skill_versions row until it commits. Returns the release state under that lock.
 */
async function lockRelease(executor: Executor, releaseId: string): Promise<{ published: boolean }> {
  if (!isUuid(releaseId)) throw improvementNotFound();
  const [release] = await rows(executor, sql`SELECT published_at FROM skill_versions WHERE id = ${releaseId}::uuid FOR NO KEY UPDATE`);
  if (!release) throw improvementNotFound();
  return { published: release.published_at !== null && release.published_at !== undefined };
}

async function insertAudit(executor: Executor, input: ImprovementAuditInput): Promise<void> {
  await executor.execute(sql`
    INSERT INTO audit_events (actor_user_id, action, decision, resource_type, resource_id, details)
    VALUES (${input.actorUserId}::uuid, ${input.action}, ${input.decision}, ${input.resourceType},
      ${input.resourceId}::uuid, ${json(sanitizeAuditDetails(input.details))}::jsonb)`);
}

/** Recheck write authority under row locks so a concurrent membership removal cannot race the write. */
async function assertScopeWriter(executor: Executor, authority: ImprovementScopeAuthority): Promise<void> {
  const { scope, actorUserId } = authority;
  if (scope.type === "user") {
    if (scope.id !== actorUserId) throw scopeForbidden();
    return;
  }
  if (!isUuid(scope.id) || !isUuid(actorUserId)) throw scopeForbidden();
  if (scope.type === "team") {
    const [membership] = await rows(executor, sql`
      SELECT m.role::text AS role, t.organization_id::text AS organization_id
      FROM team_memberships m JOIN teams t ON t.id = m.team_id
      WHERE m.team_id = ${scope.id}::uuid AND m.user_id = ${actorUserId}::uuid
      FOR SHARE OF m`);
    if (!membership || membership.role !== "owner") throw scopeForbidden();
    if (membership.organization_id !== null && !await activeOrganizationRole(executor, String(membership.organization_id), actorUserId)) throw scopeForbidden();
    return;
  }
  const role = await activeOrganizationRole(executor, scope.id, actorUserId);
  if (role !== "owner" && role !== "admin") throw scopeForbidden();
}

async function activeOrganizationRole(executor: Executor, organizationId: string, userId: string): Promise<string | null> {
  const [membership] = await rows(executor, sql`
    SELECT m.role::text AS role
    FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
    WHERE m.organization_id = ${organizationId}::uuid AND m.user_id = ${userId}::uuid
      AND m.removed_at IS NULL AND o.status = 'active'
    FOR SHARE OF m`);
  return membership ? String(membership.role) : null;
}

async function lockRunVersion(executor: Executor, runId: string, expectedVersion: number): Promise<void> {
  const [run] = await rows(executor, sql`SELECT version FROM improvement_runs WHERE id = ${runId}::uuid FOR UPDATE`);
  if (!run) throw improvementNotFound();
  if (Number(run.version) !== expectedVersion) throw runConflict();
}

async function updateRunRow(executor: Executor, runId: string, expectedVersion: number, next: RunMutation): Promise<RunRecord> {
  const [row] = await rows(executor, sql`
    UPDATE improvement_runs SET
      state = ${next.progress.state},
      progress = ${json(next.progress)}::jsonb,
      last_sequence = ${next.lastSequence},
      cancellation = ${next.cancellation},
      updated_at = ${next.updatedAt}::timestamptz,
      completed_at = ${next.completedAt}::timestamptz,
      version = version + 1
    WHERE id = ${runId}::uuid AND version = ${expectedVersion}
    RETURNING *`);
  if (!row) throw runConflict();
  return runRow(row);
}

async function insertDocumentRevision(executor: Executor, documentId: string, revisionNumber: number, revision: Omit<DocumentRevisionRecord, "revisionNumber">): Promise<void> {
  await executor.execute(sql`
    INSERT INTO improvement_document_revisions (id, document_id, revision_number, body, body_sha256, reason, created_by_user_id, created_at)
    VALUES (${revision.id}::uuid, ${documentId}::uuid, ${revisionNumber}, ${json(revision.body)}::jsonb, ${revision.bodySha256},
      ${revision.reason}, ${revision.createdByUserId}::uuid, ${revision.createdAt}::timestamptz)`);
}

function declarationQuery(where: SQL): SQL {
  return sql`
    SELECT r.*, v.decision AS review_decision, v.binding_sha256 AS review_binding_sha256, v.artifact_sha256 AS review_artifact_sha256,
      v.reviewer_user_id AS review_reviewer_user_id, v.reason AS review_reason, v.created_at AS review_created_at
    FROM improvement_declaration_revisions r
    LEFT JOIN improvement_declaration_reviews v ON v.revision_id = r.id
    WHERE ${where}
    ORDER BY r.revision_number`;
}

function declarationRow(row: Row): DeclarationRevisionRecord {
  const review: DeclarationReviewRecord | null = row.review_decision
    ? {
      decision: String(row.review_decision) as DeclarationReviewRecord["decision"],
      bindingSha256: String(row.review_binding_sha256),
      artifactSha256: String(row.review_artifact_sha256),
      reviewerUserId: String(row.review_reviewer_user_id),
      reason: String(row.review_reason ?? ""),
      createdAt: iso(row.review_created_at),
    }
    : null;
  return {
    id: String(row.id),
    releaseId: String(row.release_id),
    slug: String(row.skill_slug),
    version: String(row.version),
    revisionNumber: Number(row.revision_number),
    kind: String(row.kind) as DeclarationRevisionRecord["kind"],
    declaration: row.declaration as DeclarationRevisionRecord["declaration"],
    declarationSha256: String(row.declaration_sha256),
    reason: String(row.reason ?? ""),
    createdByUserId: String(row.created_by_user_id),
    createdAt: iso(row.created_at),
    review,
  };
}

function policyRow(row: Row): PolicyRevisionRecord {
  return {
    id: String(row.id),
    scope: { type: String(row.scope_type) as ImprovementScopeRef["type"], id: String(row.scope_id) },
    revisionNumber: Number(row.revision_number),
    policy: row.policy as PolicyRevisionRecord["policy"],
    policySha256: String(row.policy_sha256),
    reason: String(row.reason ?? ""),
    createdByUserId: String(row.created_by_user_id),
    createdAt: iso(row.created_at),
  };
}

function documentRevisionRow(row: Row): DocumentRevisionRecord {
  return {
    id: String(row.id),
    revisionNumber: Number(row.revision_number),
    body: row.body as DocumentRevisionRecord["body"],
    bodySha256: String(row.body_sha256),
    reason: String(row.reason ?? ""),
    createdByUserId: String(row.created_by_user_id),
    createdAt: iso(row.created_at),
  };
}

function planRow(row: Row): PlanRecord {
  return {
    id: String(row.id),
    actorUserId: String(row.actor_user_id),
    idempotencyKey: String(row.idempotency_key),
    requestSha256: String(row.request_sha256),
    request: row.request as PlanRecord["request"],
    planSha256: String(row.plan_sha256),
    plan: row.plan as PlanRecord["plan"],
    effectivePolicy: row.effective_policy as PlanRecord["effectivePolicy"],
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
  };
}

function runRow(row: Row): RunRecord {
  return {
    id: String(row.id),
    planId: String(row.plan_id),
    planSha256: String(row.plan_sha256),
    actorUserId: String(row.actor_user_id),
    attempt: Number(row.attempt),
    idempotencyKey: String(row.idempotency_key),
    runnerSha256: String(row.runner_sha256),
    runner: row.runner as RunRecord["runner"],
    progress: row.progress as RunRecord["progress"],
    lastSequence: Number(row.last_sequence),
    version: Number(row.version),
    cancellation: String(row.cancellation) as RunRecord["cancellation"],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : iso(row.completed_at),
  };
}

function eventRow(row: Row): RunEventRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    sequence: Number(row.sequence),
    type: String(row.type) as RunEventRecord["type"],
    event: row.event as RunEventRecord["event"],
    eventSha256: String(row.event_sha256),
    createdAt: iso(row.created_at),
  };
}

function evidenceRow(row: Row): EvidenceRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    planId: String(row.plan_id),
    reporterUserId: String(row.reporter_user_id),
    context: row.context as EvidenceRecord["context"],
    idempotencyKey: String(row.idempotency_key),
    requestSha256: String(row.request_sha256),
    disclosure: String(row.disclosure) as EvidenceRecord["disclosure"],
    provenance: String(row.provenance) as EvidenceRecord["provenance"],
    summary: row.summary as EvidenceRecord["summary"],
    evidenceSha256: String(row.evidence_sha256),
    proposals: row.proposals as EvidenceRecord["proposals"],
    createdAt: iso(row.created_at),
  };
}

function acceptanceRow(row: Row): EvidenceAcceptanceRecord {
  return {
    id: String(row.id),
    evidenceId: String(row.evidence_id),
    releaseId: String(row.release_id),
    subject: String(row.subject) as EvidenceAcceptanceRecord["subject"],
    evidenceSha256: String(row.evidence_sha256),
    decision: String(row.decision) as EvidenceAcceptanceRecord["decision"],
    provenance: String(row.provenance) as EvidenceAcceptanceRecord["provenance"],
    actorUserId: String(row.actor_user_id),
    reason: String(row.reason ?? ""),
    createdAt: iso(row.created_at),
  };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
