import { AppError, optimizationDeclarationApprovalDigest, optimizationDeclarationDigest } from "@myskills-app/core";
import type {
  EffectiveImprovementPolicyV1,
  ImprovementDisclosure,
  ImprovementEvaluationSuiteV1,
  ImprovementEvidenceSummaryV1,
  ImprovementPlanRequestV1,
  ImprovementPlanV1,
  ImprovementPolicyV1,
  ImprovementProvenance,
  ImprovementRunEventV1,
  ImprovementRunnerV1,
  ImprovementRunProgressV1,
  ImprovementScopeRef,
  ImprovementTargetProfileV1,
  OptimizationDeclarationV1,
} from "@myskills-app/core";
import type { Role } from "@myskills-app/auth";

export interface ImprovementActor {
  id: string;
  email: string;
  name: string;
  roles: Role[];
  mfaVerified: boolean;
}

export interface ImprovementAuditInput {
  actorUserId: string | null;
  action: string;
  decision: "allow" | "deny";
  resourceType: string;
  resourceId: string | null;
  details: Record<string, unknown>;
}

/** Scope write authority rechecked inside the persistence boundary where the store supports it. */
export interface ImprovementScopeAuthority {
  actorUserId: string;
  scope: ImprovementScopeRef;
}

export interface DeclarationReviewRecord {
  decision: "approve" | "reject";
  bindingSha256: string;
  artifactSha256: string;
  reviewerUserId: string;
  reason: string;
  createdAt: string;
}

export interface DeclarationRevisionRecord {
  id: string;
  releaseId: string;
  slug: string;
  version: string;
  revisionNumber: number;
  kind: "declaration" | "attestation";
  declaration: OptimizationDeclarationV1;
  declarationSha256: string;
  reason: string;
  createdByUserId: string;
  createdAt: string;
  review: DeclarationReviewRecord | null;
}

export interface PolicyRevisionRecord {
  id: string;
  scope: ImprovementScopeRef;
  revisionNumber: number;
  policy: ImprovementPolicyV1;
  policySha256: string;
  reason: string;
  createdByUserId: string;
  createdAt: string;
}

export type ImprovementDocumentKind = "profile" | "suite";

export interface DocumentRevisionRecord {
  id: string;
  revisionNumber: number;
  body: ImprovementTargetProfileV1 | ImprovementEvaluationSuiteV1;
  bodySha256: string;
  reason: string;
  createdByUserId: string;
  createdAt: string;
}

export interface DocumentRecord {
  id: string;
  kind: ImprovementDocumentKind;
  owner: ImprovementScopeRef;
  createdByUserId: string;
  createdAt: string;
  latest: DocumentRevisionRecord;
  revisions: DocumentRevisionRecord[];
}

export interface PlanRecord {
  id: string;
  actorUserId: string;
  idempotencyKey: string;
  requestSha256: string;
  request: ImprovementPlanRequestV1;
  planSha256: string;
  plan: ImprovementPlanV1;
  effectivePolicy: EffectiveImprovementPolicyV1;
  createdAt: string;
  expiresAt: string;
}

export type RunCancellation = "not-requested" | "requested-unconfirmed" | "requested";

export interface RunRecord {
  id: string;
  planId: string;
  planSha256: string;
  actorUserId: string;
  attempt: number;
  idempotencyKey: string;
  runnerSha256: string;
  runner: ImprovementRunnerV1;
  progress: ImprovementRunProgressV1;
  lastSequence: number;
  version: number;
  cancellation: RunCancellation;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type RunMutation = Pick<RunRecord, "progress" | "lastSequence" | "cancellation" | "updatedAt" | "completedAt">;

export interface RunEventRecord {
  id: string;
  runId: string;
  sequence: number;
  type: ImprovementRunEventV1["type"];
  event: ImprovementRunEventV1;
  eventSha256: string;
  createdAt: string;
}

export interface EvidenceProposal {
  subject: "baseline" | "candidate";
  releaseId: string;
  slug: string;
  version: string;
  artifactSha256: string;
}

export interface EvidenceRecord {
  id: string;
  runId: string;
  planId: string;
  reporterUserId: string;
  context: ImprovementScopeRef;
  idempotencyKey: string;
  requestSha256: string;
  disclosure: Exclude<ImprovementDisclosure, "local-only">;
  provenance: ImprovementProvenance;
  summary: ImprovementEvidenceSummaryV1;
  evidenceSha256: string;
  proposals: EvidenceProposal[];
  createdAt: string;
}

export interface EvidenceAcceptanceRecord {
  id: string;
  evidenceId: string;
  releaseId: string;
  subject: "baseline" | "candidate";
  evidenceSha256: string;
  decision: "accept" | "reject";
  provenance: ImprovementProvenance;
  actorUserId: string;
  reason: string;
  createdAt: string;
}

/** Synchronous release publication state, read inside a memory declaration write. Null when the release is missing. */
export interface ReleasePublicationReader {
  releasePublished(releaseId: string): boolean | null;
}

/** Active sharing scopes of a skill. Owners are users; grants carry organization or team governance. */
export interface SkillGovernance {
  visibility: string;
  organizationIds: string[];
  teams: Array<{ id: string; organizationId: string | null }>;
}

export interface ImprovementStore {
  readonly kind: "memory" | "postgres";
  recordAudit(input: ImprovementAuditInput): Promise<void>;
  getSkillGovernance(slug: string): Promise<SkillGovernance | null>;

  listDeclarationRevisions(releaseId: string): Promise<DeclarationRevisionRecord[]>;
  appendDeclarationRevision(input: {
    revision: Omit<DeclarationRevisionRecord, "revisionNumber" | "review">;
    expectedRevisionNumber: number;
    audit: ImprovementAuditInput;
  }): Promise<{ revision: DeclarationRevisionRecord; created: boolean }>;
  reviewDeclarationRevision(input: {
    releaseId: string;
    revisionId: string;
    review: DeclarationReviewRecord;
    audit: ImprovementAuditInput;
  }): Promise<DeclarationRevisionRecord>;

  getLatestPolicy(scope: ImprovementScopeRef): Promise<PolicyRevisionRecord | null>;
  appendPolicyRevision(input: {
    revision: Omit<PolicyRevisionRecord, "revisionNumber">;
    expectedRevisionNumber: number;
    authority: ImprovementScopeAuthority;
    audit: ImprovementAuditInput;
  }): Promise<{ revision: PolicyRevisionRecord; created: boolean }>;

  listDocuments(kind: ImprovementDocumentKind, owner: ImprovementScopeRef): Promise<DocumentRecord[]>;
  getDocument(id: string): Promise<DocumentRecord | null>;
  getDocumentByRevision(revisionId: string): Promise<DocumentRecord | null>;
  createDocument(input: {
    document: Pick<DocumentRecord, "id" | "kind" | "owner" | "createdByUserId" | "createdAt">;
    revision: Omit<DocumentRevisionRecord, "revisionNumber">;
    authority: ImprovementScopeAuthority;
    audit: ImprovementAuditInput;
  }): Promise<DocumentRecord>;
  appendDocumentRevision(input: {
    documentId: string;
    revision: Omit<DocumentRevisionRecord, "revisionNumber">;
    expectedRevisionNumber: number;
    authority: ImprovementScopeAuthority;
    audit: ImprovementAuditInput;
  }): Promise<{ document: DocumentRecord; created: boolean }>;

  findPlanByIdempotencyKey(actorUserId: string, idempotencyKey: string): Promise<PlanRecord | null>;
  createPlan(input: { plan: PlanRecord; audit: ImprovementAuditInput }): Promise<{ plan: PlanRecord; created: boolean }>;
  getPlan(id: string): Promise<PlanRecord | null>;

  listRunsForPlan(planId: string): Promise<RunRecord[]>;
  /** Enforces unique attempts, one non-terminal attempt per plan, and idempotency keys. */
  createRun(input: { run: RunRecord; audit: ImprovementAuditInput }): Promise<{ run: RunRecord; created: boolean }>;
  getRun(id: string): Promise<RunRecord | null>;
  listRunEvents(runId: string): Promise<RunEventRecord[]>;
  /** Compare-and-set on the run version; appends the event and the resulting run state atomically. */
  appendRunEvent(input: { runId: string; expectedVersion: number; event: RunEventRecord; next: RunMutation; audit: ImprovementAuditInput }): Promise<RunRecord>;
  updateRun(input: { runId: string; expectedVersion: number; next: RunMutation; audit: ImprovementAuditInput }): Promise<RunRecord>;

  findEvidenceByIdempotencyKey(reporterUserId: string, idempotencyKey: string): Promise<EvidenceRecord | null>;
  createEvidence(input: { evidence: EvidenceRecord; audit: ImprovementAuditInput }): Promise<{ evidence: EvidenceRecord; created: boolean }>;
  getEvidence(id: string): Promise<EvidenceRecord | null>;
  listEvidenceProposedForRelease(releaseId: string): Promise<EvidenceRecord[]>;
  listAcceptances(input: { evidenceId?: string; releaseId?: string }): Promise<EvidenceAcceptanceRecord[]>;
  createAcceptance(input: { acceptance: EvidenceAcceptanceRecord; audit: ImprovementAuditInput }): Promise<EvidenceAcceptanceRecord>;
}

export function improvementError(code: string, message: string, statusCode: number, details?: unknown): AppError {
  return new AppError(message, code, statusCode, details);
}

/** True when the revision's approval binds this exact release, artifact, revision, and declaration digest. */
export function declarationApprovalMatches(revision: DeclarationRevisionRecord, release: { releaseId: string; artifactSha256: string }): boolean {
  const review = revision.review;
  if (!review || review.decision !== "approve") return false;
  const binding = optimizationDeclarationApprovalDigest({
    releaseId: release.releaseId,
    artifactSha256: release.artifactSha256,
    declarationRevisionId: revision.id,
    declarationSha256: revision.declarationSha256,
  });
  return review.bindingSha256 === binding && revision.declarationSha256 === optimizationDeclarationDigest(revision.declaration);
}

/**
 * Publication precondition. Releases without an author declaration publish as before; otherwise the
 * latest declaration revision must be approved for the artifact being published. Attestations are
 * post-publication records and never gate publication.
 */
export function declarationPublicationBlocker(
  revisions: readonly DeclarationRevisionRecord[],
  release: { releaseId: string; artifactSha256: string },
): AppError | null {
  const latest = revisions
    .filter((item) => item.releaseId === release.releaseId && item.kind === "declaration")
    .sort((left, right) => right.revisionNumber - left.revisionNumber)[0];
  if (!latest || declarationApprovalMatches(latest, release)) return null;
  const status = !latest.review ? "pending" : latest.review.decision === "reject" ? "rejected" : "binding-mismatch";
  const message = status === "pending"
    ? `Release declaration revision ${latest.revisionNumber} is awaiting review. Approve it for this artifact before publishing.`
    : status === "rejected"
      ? `Release declaration revision ${latest.revisionNumber} was rejected. Append a corrected or unspecified revision and approve it before publishing.`
      : `Release declaration revision ${latest.revisionNumber} is not approved for this artifact. Append a new revision and approve it before publishing.`;
  return improvementError("RELEASE_DECLARATION_NOT_APPROVED", message, 409, { revisionId: latest.id, revisionNumber: latest.revisionNumber, status });
}

export function improvementNotFound(): AppError {
  return improvementError("IMPROVEMENT_NOT_FOUND", "Improvement record not found.", 404);
}

export function revisionConflict(currentRevisionNumber: number): AppError {
  return improvementError("IMPROVEMENT_REVISION_CONFLICT", "The record changed. Refresh before saving.", 409, { currentRevisionNumber });
}

export function runConflict(): AppError {
  return improvementError("IMPROVEMENT_RUN_CONFLICT", "The run changed concurrently. Refresh and retry.", 409);
}

export function runActive(): AppError {
  return improvementError("IMPROVEMENT_RUN_ACTIVE", "This plan already has an active run.", 409);
}

export function idempotencyConflict(): AppError {
  return improvementError("IMPROVEMENT_IDEMPOTENCY_CONFLICT", "The idempotency key was used for a different request.", 409);
}

export function declarationReviewed(): AppError {
  return improvementError("IMPROVEMENT_DECLARATION_REVIEWED", "This declaration revision has already been reviewed.", 409);
}

export function declarationStale(): AppError {
  return improvementError("IMPROVEMENT_DECLARATION_STALE", "A newer revision of this kind exists. Review the latest revision.", 409);
}

export function releaseStateChanged(): AppError {
  return improvementError(
    "IMPROVEMENT_RELEASE_STATE_CHANGED",
    "The release was published while this declaration was being saved. Refresh and submit it again as an attestation.",
    409,
  );
}

export function evidenceReviewed(): AppError {
  return improvementError("IMPROVEMENT_EVIDENCE_REVIEWED", "This evidence already has a decision for this release.", 409);
}

export function scopeForbidden(): AppError {
  return improvementError("IMPROVEMENT_SCOPE_FORBIDDEN", "The current user cannot change this scope.", 403);
}
