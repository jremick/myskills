import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type { ImprovementScopeRef } from "@myskills-app/core";
import type { ReleasePublicationCandidate, ReleasePublicationGuard } from "../submissions/types.js";
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
  type DeclarationRevisionRecord,
  type DocumentRecord,
  type EvidenceAcceptanceRecord,
  type EvidenceRecord,
  type ImprovementAuditInput,
  type ImprovementDocumentKind,
  type ImprovementStore,
  type PlanRecord,
  type PolicyRevisionRecord,
  type ReleasePublicationReader,
  type RunEventRecord,
  type RunRecord,
  type SkillGovernance,
} from "./types.js";

interface MemoryAuditEvent extends ImprovementAuditInput {
  createdAt: string;
}

/**
 * In-memory parity store. Every mutation is synchronous after its inputs are prepared, so the
 * compare-and-set checks here are atomic within one Node.js process. With a release reader and
 * this store as the submission store's publication guard, declaration writes and publication
 * observe each other's committed state.
 */
export class MemoryImprovementStore implements ImprovementStore, ReleasePublicationGuard {
  readonly kind = "memory" as const;
  private readonly audits: MemoryAuditEvent[] = [];
  private readonly governance = new Map<string, SkillGovernance>();
  private readonly declarations: DeclarationRevisionRecord[] = [];
  private readonly policies: PolicyRevisionRecord[] = [];
  private readonly documents = new Map<string, DocumentRecord>();
  private readonly plans = new Map<string, PlanRecord>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly events: RunEventRecord[] = [];
  private readonly evidence = new Map<string, EvidenceRecord>();
  private readonly acceptances: EvidenceAcceptanceRecord[] = [];

  constructor(private readonly options: { releases?: ReleasePublicationReader } = {}) {}

  /** Publication guard; synchronous so the memory submission store's check and write stay atomic. */
  assertReleasePublishable(release: ReleasePublicationCandidate): void {
    const blocker = declarationPublicationBlocker(this.declarations, release);
    if (blocker) throw blocker;
  }

  /** Test and fixture hook: record the active sharing scopes of a skill. */
  setSkillGovernance(slug: string, governance: SkillGovernance): void {
    this.governance.set(slug, structuredClone(governance));
  }

  auditEvents(): MemoryAuditEvent[] {
    return structuredClone(this.audits);
  }

  async recordAudit(input: ImprovementAuditInput): Promise<void> {
    this.audit(input);
  }

  async getSkillGovernance(slug: string): Promise<SkillGovernance | null> {
    const governance = this.governance.get(slug);
    return governance ? structuredClone(governance) : null;
  }

  async listDeclarationRevisions(releaseId: string): Promise<DeclarationRevisionRecord[]> {
    return structuredClone(this.declarations.filter((item) => item.releaseId === releaseId).sort((left, right) => left.revisionNumber - right.revisionNumber));
  }

  async appendDeclarationRevision(input: Parameters<ImprovementStore["appendDeclarationRevision"]>[0]): Promise<{ revision: DeclarationRevisionRecord; created: boolean }> {
    const published = this.options.releases?.releasePublished(input.revision.releaseId);
    if (published === null) throw improvementNotFound();
    const existing = this.declarations.filter((item) => item.releaseId === input.revision.releaseId);
    const latest = existing.sort((left, right) => right.revisionNumber - left.revisionNumber)[0];
    const latestNumber = latest?.revisionNumber ?? 0;
    if (latest && latest.declarationSha256 === input.revision.declarationSha256 && latest.kind === input.revision.kind
      && input.expectedRevisionNumber === latestNumber - 1) {
      return { revision: structuredClone(latest), created: false };
    }
    // The service chose the kind from an earlier read; publication may have happened since.
    if (published !== undefined && input.revision.kind !== (published ? "attestation" : "declaration")) throw releaseStateChanged();
    if (latestNumber !== input.expectedRevisionNumber) throw revisionConflict(latestNumber);
    const revision: DeclarationRevisionRecord = { ...structuredClone(input.revision), revisionNumber: latestNumber + 1, review: null };
    this.declarations.push(revision);
    this.audit({ ...input.audit, resourceId: revision.id });
    return { revision: structuredClone(revision), created: true };
  }

  async reviewDeclarationRevision(input: Parameters<ImprovementStore["reviewDeclarationRevision"]>[0]): Promise<DeclarationRevisionRecord> {
    const revision = this.declarations.find((item) => item.id === input.revisionId && item.releaseId === input.releaseId);
    if (!revision) throw improvementNotFound();
    if (revision.review) throw declarationReviewed();
    const newer = this.declarations.some((item) => item.releaseId === input.releaseId && item.kind === revision.kind && item.revisionNumber > revision.revisionNumber);
    if (newer) throw declarationStale();
    revision.review = structuredClone(input.review);
    this.audit(input.audit);
    return structuredClone(revision);
  }

  async getLatestPolicy(scope: ImprovementScopeRef): Promise<PolicyRevisionRecord | null> {
    const latest = this.policies
      .filter((item) => sameScope(item.scope, scope))
      .sort((left, right) => right.revisionNumber - left.revisionNumber)[0];
    return latest ? structuredClone(latest) : null;
  }

  async appendPolicyRevision(input: Parameters<ImprovementStore["appendPolicyRevision"]>[0]): Promise<{ revision: PolicyRevisionRecord; created: boolean }> {
    const latest = await this.getLatestPolicy(input.revision.scope);
    const latestNumber = latest?.revisionNumber ?? 0;
    if (latestNumber !== input.expectedRevisionNumber) throw revisionConflict(latestNumber);
    if (latest?.policySha256 === input.revision.policySha256) return { revision: latest, created: false };
    const revision: PolicyRevisionRecord = { ...structuredClone(input.revision), revisionNumber: latestNumber + 1 };
    this.policies.push(revision);
    this.audit({ ...input.audit, resourceId: revision.id, details: { ...input.audit.details, revisionNumber: revision.revisionNumber } });
    return { revision: structuredClone(revision), created: true };
  }

  async listDocuments(kind: ImprovementDocumentKind, owner: ImprovementScopeRef): Promise<DocumentRecord[]> {
    return structuredClone([...this.documents.values()]
      .filter((item) => item.kind === kind && sameScope(item.owner, owner))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)));
  }

  async getDocument(id: string): Promise<DocumentRecord | null> {
    const document = this.documents.get(id);
    return document ? structuredClone(document) : null;
  }

  async getDocumentByRevision(revisionId: string): Promise<DocumentRecord | null> {
    const document = [...this.documents.values()].find((item) => item.revisions.some((revision) => revision.id === revisionId));
    return document ? structuredClone(document) : null;
  }

  async createDocument(input: Parameters<ImprovementStore["createDocument"]>[0]): Promise<DocumentRecord> {
    const revision = { ...structuredClone(input.revision), revisionNumber: 1 };
    const document: DocumentRecord = { ...structuredClone(input.document), latest: revision, revisions: [revision] };
    this.documents.set(document.id, document);
    this.audit({ ...input.audit, resourceId: document.id });
    return structuredClone(document);
  }

  async appendDocumentRevision(input: Parameters<ImprovementStore["appendDocumentRevision"]>[0]): Promise<{ document: DocumentRecord; created: boolean }> {
    const document = this.documents.get(input.documentId);
    if (!document) throw improvementNotFound();
    if (document.latest.revisionNumber !== input.expectedRevisionNumber) throw revisionConflict(document.latest.revisionNumber);
    if (document.latest.bodySha256 === input.revision.bodySha256) return { document: structuredClone(document), created: false };
    const revision = { ...structuredClone(input.revision), revisionNumber: document.latest.revisionNumber + 1 };
    document.revisions.push(revision);
    document.latest = revision;
    this.audit({ ...input.audit, resourceId: document.id, details: { ...input.audit.details, revisionNumber: revision.revisionNumber } });
    return { document: structuredClone(document), created: true };
  }

  async findPlanByIdempotencyKey(actorUserId: string, idempotencyKey: string): Promise<PlanRecord | null> {
    const plan = [...this.plans.values()].find((item) => item.actorUserId === actorUserId && item.idempotencyKey === idempotencyKey);
    return plan ? structuredClone(plan) : null;
  }

  async createPlan(input: Parameters<ImprovementStore["createPlan"]>[0]): Promise<{ plan: PlanRecord; created: boolean }> {
    const existing = await this.findPlanByIdempotencyKey(input.plan.actorUserId, input.plan.idempotencyKey);
    if (existing) return { plan: existing, created: false };
    this.plans.set(input.plan.id, structuredClone(input.plan));
    this.audit(input.audit);
    return { plan: structuredClone(input.plan), created: true };
  }

  async getPlan(id: string): Promise<PlanRecord | null> {
    const plan = this.plans.get(id);
    return plan ? structuredClone(plan) : null;
  }

  async listRunsForPlan(planId: string): Promise<RunRecord[]> {
    return structuredClone([...this.runs.values()].filter((item) => item.planId === planId).sort((left, right) => left.attempt - right.attempt));
  }

  async createRun(input: Parameters<ImprovementStore["createRun"]>[0]): Promise<{ run: RunRecord; created: boolean }> {
    const runs = [...this.runs.values()].filter((item) => item.planId === input.run.planId);
    const replay = runs.find((item) => item.idempotencyKey === input.run.idempotencyKey);
    if (replay) return { run: structuredClone(replay), created: false };
    if (runs.some((item) => item.progress.state === "running")) throw runActive();
    if (runs.some((item) => item.attempt === input.run.attempt)) throw runConflict();
    this.runs.set(input.run.id, structuredClone(input.run));
    this.audit(input.audit);
    return { run: structuredClone(input.run), created: true };
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : null;
  }

  async listRunEvents(runId: string): Promise<RunEventRecord[]> {
    return structuredClone(this.events.filter((item) => item.runId === runId).sort((left, right) => left.sequence - right.sequence));
  }

  async appendRunEvent(input: Parameters<ImprovementStore["appendRunEvent"]>[0]): Promise<RunRecord> {
    const run = this.runs.get(input.runId);
    if (!run) throw improvementNotFound();
    if (run.version !== input.expectedVersion || this.events.some((item) => item.runId === input.runId && item.sequence === input.event.sequence)) throw runConflict();
    this.events.push(structuredClone(input.event));
    Object.assign(run, structuredClone(input.next), { version: run.version + 1 });
    this.audit(input.audit);
    return structuredClone(run);
  }

  async updateRun(input: Parameters<ImprovementStore["updateRun"]>[0]): Promise<RunRecord> {
    const run = this.runs.get(input.runId);
    if (!run) throw improvementNotFound();
    if (run.version !== input.expectedVersion) throw runConflict();
    Object.assign(run, structuredClone(input.next), { version: run.version + 1 });
    this.audit(input.audit);
    return structuredClone(run);
  }

  async findEvidenceByIdempotencyKey(reporterUserId: string, idempotencyKey: string): Promise<EvidenceRecord | null> {
    const evidence = [...this.evidence.values()].find((item) => item.reporterUserId === reporterUserId && item.idempotencyKey === idempotencyKey);
    return evidence ? structuredClone(evidence) : null;
  }

  async createEvidence(input: Parameters<ImprovementStore["createEvidence"]>[0]): Promise<{ evidence: EvidenceRecord; created: boolean }> {
    const existing = await this.findEvidenceByIdempotencyKey(input.evidence.reporterUserId, input.evidence.idempotencyKey);
    if (existing) return { evidence: existing, created: false };
    this.evidence.set(input.evidence.id, structuredClone(input.evidence));
    this.audit(input.audit);
    return { evidence: structuredClone(input.evidence), created: true };
  }

  async getEvidence(id: string): Promise<EvidenceRecord | null> {
    const evidence = this.evidence.get(id);
    return evidence ? structuredClone(evidence) : null;
  }

  async listEvidenceProposedForRelease(releaseId: string): Promise<EvidenceRecord[]> {
    return structuredClone([...this.evidence.values()]
      .filter((item) => item.proposals.some((proposal) => proposal.releaseId === releaseId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)));
  }

  async listAcceptances(input: { evidenceId?: string; releaseId?: string }): Promise<EvidenceAcceptanceRecord[]> {
    return structuredClone(this.acceptances
      .filter((item) => (!input.evidenceId || item.evidenceId === input.evidenceId) && (!input.releaseId || item.releaseId === input.releaseId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)));
  }

  async createAcceptance(input: Parameters<ImprovementStore["createAcceptance"]>[0]): Promise<EvidenceAcceptanceRecord> {
    const duplicate = this.acceptances.some((item) => item.evidenceId === input.acceptance.evidenceId
      && item.releaseId === input.acceptance.releaseId && item.subject === input.acceptance.subject);
    if (duplicate) throw evidenceReviewed();
    this.acceptances.push(structuredClone(input.acceptance));
    this.audit(input.audit);
    return structuredClone(input.acceptance);
  }

  private audit(input: ImprovementAuditInput): void {
    this.audits.push({ ...input, details: sanitizeAuditDetails(input.details), createdAt: new Date().toISOString() });
  }
}

function sameScope(left: ImprovementScopeRef, right: ImprovementScopeRef): boolean {
  return left.type === right.type && left.id === right.id;
}
