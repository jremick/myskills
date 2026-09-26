import { randomUUID } from "node:crypto";
import {
  AppError,
  applyImprovementRunEvent,
  buildImprovementEvidenceSummaryV1,
  composeImprovementPolicies,
  deriveImprovementEvidenceClaim,
  hasIndependentEvaluator,
  ImprovementContractError,
  improvementDigest,
  improvementDisclosureRank,
  improvementDocumentDigest,
  improvementEffectivePolicyDigest,
  improvementPlanDigest,
  improvementPlanSourceTreeSha256,
  improvementPolicyDigest,
  improvementRunGuarantees,
  improvementRunnerMissingCapabilities,
  ImprovementRunRejection,
  initialImprovementRunProgress,
  normalizeImprovementEvaluationSuiteV1,
  normalizeImprovementPlanRequestV1,
  normalizeImprovementPolicyV1,
  normalizeImprovementRunEventV1,
  normalizeImprovementRunnerV1,
  normalizeImprovementScopeRef,
  normalizeImprovementTargetProfileV1,
  normalizeOptimizationDeclarationV1,
  optimizationDeclarationApprovalDigest,
  optimizationDeclarationDigest,
  optimizationTargetMatchesProfile,
  type EffectiveImprovementPolicyV1,
  type ImprovementEvaluationSuiteV1,
  type ImprovementPlanRequestV1,
  type ImprovementPlanV1,
  type ImprovementPolicyBlocker,
  type ImprovementPolicyConstraintInput,
  type ImprovementPolicyConstraintV1,
  type ImprovementRunProgressV1,
  type ImprovementConstraintReason,
  type ImprovementScopeRef,
  type ImprovementTargetProfileV1,
  type ReleaseCompatibilityProjectionV1,
  type ReleaseCompatibilityRevisionV1,
} from "@myskills-app/core";
import type { SubmissionService } from "../submissions/service.js";
import type { AuthStore } from "../auth/types.js";
import type { TeamService } from "../teams/service.js";
import type { OrganizationService } from "../organizations/service.js";
import {
  declarationApprovalMatches,
  idempotencyConflict,
  improvementError,
  improvementNotFound,
  scopeForbidden,
  type DeclarationRevisionRecord,
  type DocumentRecord,
  type DocumentRevisionRecord,
  type EvidenceProposal,
  type EvidenceRecord,
  type ImprovementActor,
  type ImprovementAuditInput,
  type ImprovementDocumentKind,
  type ImprovementStore,
  type PlanRecord,
  type RunEventRecord,
  type RunMutation,
  type RunRecord,
} from "./types.js";

export interface ImprovementServiceDependencies {
  submissionService: SubmissionService;
  authStore: Pick<AuthStore, "findUserById">;
  teamService?: TeamService;
  organizationService?: OrganizationService;
}

interface ResolvedRelease {
  releaseId: string;
  slug: string;
  version: string;
  artifactSha256: string;
  published: boolean;
  lifecycleStatus: string;
  canManage: boolean;
}

interface PlanResolution {
  effectivePolicy: EffectiveImprovementPolicyV1;
  plan: ImprovementPlanV1 | null;
  unavailable: boolean;
}

type ScopeRole = "owner" | "admin" | "member";

const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,128}$/;
const pathIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const unavailableCodes = new Set(["SOURCE_UNAVAILABLE", "REVIEWER_UNAVAILABLE", "PROFILE_UNAVAILABLE", "SUITE_UNAVAILABLE"]);

/**
 * Skill improvement domain. Authorization is rechecked against current memberships, release
 * visibility, and policy revisions at every mutation; nothing here executes or attests local work.
 */
export class ImprovementService {
  constructor(
    private readonly store: ImprovementStore,
    private readonly deps: ImprovementServiceDependencies,
    private readonly options: { now?: () => Date; idFactory?: () => string } = {},
  ) {}

  // ---- Release declarations and compatibility -------------------------------------------------

  async getCompatibility(actor: ImprovementActor | null, slug: string, version: string): Promise<ReleaseCompatibilityProjectionV1> {
    const release = await this.resolveRelease(actor, pathParam(slug), pathParam(version));
    if (!release) throw releaseNotFound();
    const revisions = await this.store.listDeclarationRevisions(release.releaseId);
    const declaration = currentApproved(revisions, "declaration", release);
    const attestation = currentApproved(revisions, "attestation", release);
    const evidence = await this.acceptedEvidence(release);
    const projection: ReleaseCompatibilityProjectionV1 = {
      schemaVersion: 1,
      release: { slug: release.slug, version: release.version, artifactSha256: release.artifactSha256, published: release.published },
      declaration: {
        status: declaration ? "approved" : "unspecified",
        revision: declaration ? publicRevision(declaration, false) : null,
        targets: declaration
          ? declaration.declaration.targets.map((target) => ({
            target,
            status: evidence.some((item) => item.relevance === "current"
              && item.evaluation[item.subject] !== null
              && item.claim !== "static-findings-only"
              && optimizationTargetMatchesProfile(target, item.profile.target)) ? "tested" as const : "designed-for-untested" as const,
          }))
          : [],
      },
      attestation: { status: attestation ? "approved" : "none", revision: attestation ? publicRevision(attestation, true) : null },
      evidence,
    };
    if (release.canManage) {
      const decided = await this.store.listAcceptances({ releaseId: release.releaseId });
      const proposals = await this.store.listEvidenceProposedForRelease(release.releaseId);
      projection.manage = {
        pendingRevisions: revisions.filter((revision) => !revision.review).map((revision) => revisionView(revision)),
        evidenceProposals: proposals.flatMap((item) => item.proposals
          .filter((proposal) => proposal.releaseId === release.releaseId
            && !decided.some((decision) => decision.evidenceId === item.id && decision.subject === proposal.subject))
          .map((proposal) => ({ evidenceId: item.id, subject: proposal.subject, createdAt: item.createdAt }))),
      };
    }
    return projection;
  }

  async appendDeclaration(actor: ImprovementActor, slug: string, version: string, body: unknown) {
    const input = contract(() => {
      const record = bodyObject(body, ["declaration", "expectedRevisionNumber", "reason"]);
      return {
        declaration: normalizeOptimizationDeclarationV1(record.declaration),
        expectedRevisionNumber: expectedRevision(record.expectedRevisionNumber),
        reason: reasonText(record.reason),
      };
    });
    const release = await this.resolveRelease(actor, pathParam(slug), pathParam(version));
    if (!release) throw releaseNotFound();
    if (!release.canManage) throw releaseManagerRequired();
    if (release.lifecycleStatus === "revoked") throw improvementError("IMPROVEMENT_RELEASE_UNAVAILABLE", "Revoked releases cannot receive declarations.", 409);
    const kind = release.published ? "attestation" as const : "declaration" as const;
    const declarationSha256 = optimizationDeclarationDigest(input.declaration);
    const id = this.id();
    const result = await this.store.appendDeclarationRevision({
      revision: {
        id,
        releaseId: release.releaseId,
        slug: release.slug,
        version: release.version,
        kind,
        declaration: input.declaration,
        declarationSha256,
        reason: input.reason,
        createdByUserId: actor.id,
        createdAt: this.nowIso(),
      },
      expectedRevisionNumber: input.expectedRevisionNumber,
      audit: this.audit(actor, "improvement.declaration.append", "improvement_declaration_revision", id, {
        releaseId: release.releaseId, slug: release.slug, version: release.version, kind, declarationSha256,
      }),
    });
    return { revision: revisionView(result.revision), created: result.created };
  }

  async reviewDeclaration(actor: ImprovementActor, slug: string, version: string, revisionId: string, body: unknown) {
    if (!canReview(actor)) throw improvementError("REVIEW_ROLE_REQUIRED", "Review requires maintainer permissions.", 403);
    requireMfa(actor);
    const input = contract(() => {
      const record = bodyObject(body, ["decision", "artifactSha256", "declarationSha256", "reason"]);
      return {
        decision: enumBody(record.decision, "decision", ["approve", "reject"] as const),
        artifactSha256: shaBody(record.artifactSha256, "artifactSha256"),
        declarationSha256: shaBody(record.declarationSha256, "declarationSha256"),
        reason: reasonText(record.reason),
      };
    });
    const release = await this.resolveRelease(actor, pathParam(slug), pathParam(version));
    if (!release) throw releaseNotFound();
    const revisions = await this.store.listDeclarationRevisions(release.releaseId);
    const revision = revisions.find((item) => item.id === pathParam(revisionId));
    if (!revision) throw improvementNotFound();
    if (revision.review) throw improvementError("IMPROVEMENT_DECLARATION_REVIEWED", "This declaration revision has already been reviewed.", 409);
    if (revisions.some((item) => item.kind === revision.kind && item.revisionNumber > revision.revisionNumber)) {
      throw improvementError("IMPROVEMENT_DECLARATION_STALE", "A newer revision of this kind exists. Review the latest revision.", 409);
    }
    if (input.artifactSha256 !== release.artifactSha256) throw bindingMismatch("The artifact digest does not match this release.");
    if (input.declarationSha256 !== revision.declarationSha256) throw bindingMismatch("The declaration digest does not match this revision.");
    const bindingSha256 = optimizationDeclarationApprovalDigest({
      releaseId: release.releaseId,
      artifactSha256: release.artifactSha256,
      declarationRevisionId: revision.id,
      declarationSha256: revision.declarationSha256,
    });
    const reviewed = await this.store.reviewDeclarationRevision({
      releaseId: release.releaseId,
      revisionId: revision.id,
      review: { decision: input.decision, bindingSha256, artifactSha256: release.artifactSha256, reviewerUserId: actor.id, reason: input.reason, createdAt: this.nowIso() },
      audit: this.audit(actor, "improvement.declaration.review", "improvement_declaration_revision", revision.id, {
        releaseId: release.releaseId, decision: input.decision, bindingSha256,
      }),
    });
    return { revision: revisionView(reviewed) };
  }

  // ---- Policies, profiles, suites -------------------------------------------------------------

  async getPolicy(actor: ImprovementActor, scopeType: string, scopeId: string) {
    const scope = contract(() => normalizeImprovementScopeRef({ type: scopeType, id: scopeId }));
    await this.requireReader(actor, scope);
    return { revision: await this.store.getLatestPolicy(scope) };
  }

  async putPolicy(actor: ImprovementActor, scopeType: string, scopeId: string, body: unknown) {
    const scope = contract(() => normalizeImprovementScopeRef({ type: scopeType, id: scopeId }));
    const input = contract(() => {
      const record = bodyObject(body, ["policy", "expectedRevisionNumber", "reason"]);
      return { policy: normalizeImprovementPolicyV1(record.policy), expectedRevisionNumber: expectedRevision(record.expectedRevisionNumber), reason: reasonText(record.reason) };
    });
    await this.requireWriter(actor, scope);
    const id = this.id();
    const policySha256 = improvementPolicyDigest(input.policy);
    return this.store.appendPolicyRevision({
      revision: { id, scope, policy: input.policy, policySha256, reason: input.reason, createdByUserId: actor.id, createdAt: this.nowIso() },
      expectedRevisionNumber: input.expectedRevisionNumber,
      authority: { actorUserId: actor.id, scope },
      audit: this.audit(actor, "improvement.policy.append", "improvement_policy_revision", id, { scopeType: scope.type, scopeId: scope.id, policySha256 }),
    });
  }

  async listDocuments(actor: ImprovementActor, kind: ImprovementDocumentKind, ownerType: unknown, ownerId: unknown) {
    const owner = contract(() => normalizeImprovementScopeRef({ type: ownerType, id: ownerId }, "owner"));
    await this.requireReader(actor, owner);
    return (await this.store.listDocuments(kind, owner)).map(documentView);
  }

  async createDocument(actor: ImprovementActor, kind: ImprovementDocumentKind, body: unknown) {
    const input = contract(() => {
      const record = bodyObject(body, ["owner", kind, "reason"]);
      return { owner: normalizeImprovementScopeRef(record.owner, "owner"), body: normalizeDocument(kind, record[kind]), reason: reasonText(record.reason) };
    });
    await this.requireWriter(actor, input.owner);
    const id = this.id();
    const revisionId = this.id();
    const createdAt = this.nowIso();
    const bodySha256 = improvementDocumentDigest(kind, input.body);
    const document = await this.store.createDocument({
      document: { id, kind, owner: input.owner, createdByUserId: actor.id, createdAt },
      revision: { id: revisionId, body: input.body, bodySha256, reason: input.reason, createdByUserId: actor.id, createdAt },
      authority: { actorUserId: actor.id, scope: input.owner },
      audit: this.audit(actor, `improvement.${kind}.create`, `improvement_${kind}`, id, { ownerType: input.owner.type, ownerId: input.owner.id, bodySha256 }),
    });
    return documentView(document);
  }

  async getDocument(actor: ImprovementActor, kind: ImprovementDocumentKind, id: string) {
    const document = await this.store.getDocument(pathParam(id));
    if (!document || document.kind !== kind || !await this.scopeRole(actor, document.owner)) throw improvementNotFound();
    return documentView(document);
  }

  async appendDocument(actor: ImprovementActor, kind: ImprovementDocumentKind, id: string, body: unknown) {
    const input = contract(() => {
      const record = bodyObject(body, [kind, "expectedRevisionNumber", "reason"]);
      return { body: normalizeDocument(kind, record[kind]), expectedRevisionNumber: expectedRevision(record.expectedRevisionNumber), reason: reasonText(record.reason) };
    });
    const document = await this.store.getDocument(pathParam(id));
    if (!document || document.kind !== kind) throw improvementNotFound();
    await this.requireWriter(actor, document.owner);
    const revisionId = this.id();
    const bodySha256 = improvementDocumentDigest(kind, input.body);
    const result = await this.store.appendDocumentRevision({
      documentId: document.id,
      revision: { id: revisionId, body: input.body, bodySha256, reason: input.reason, createdByUserId: actor.id, createdAt: this.nowIso() },
      expectedRevisionNumber: input.expectedRevisionNumber,
      authority: { actorUserId: actor.id, scope: document.owner },
      audit: this.audit(actor, `improvement.${kind}.append`, `improvement_${kind}`, document.id, { ownerType: document.owner.type, ownerId: document.owner.id, bodySha256 }),
    });
    return { document: documentView(result.document), created: result.created };
  }

  // ---- Plans ----------------------------------------------------------------------------------

  async previewPlan(actor: ImprovementActor, body: unknown) {
    const request = contract(() => normalizeImprovementPlanRequestV1(bodyObject(body, ["request"]).request));
    const resolution = await this.resolvePlan(actor, request, "preview");
    return {
      effectivePolicy: resolution.effectivePolicy,
      plan: resolution.plan,
      planSha256: resolution.plan ? improvementPlanDigest(resolution.plan) : null,
    };
  }

  async createPlan(actor: ImprovementActor, body: unknown) {
    const input = contract(() => {
      const record = bodyObject(body, ["request", "idempotencyKey"]);
      return { request: normalizeImprovementPlanRequestV1(record.request), idempotencyKey: idempotencyKey(record.idempotencyKey) };
    });
    if (input.request.context.type !== "user") requireMfa(actor);
    const requestSha256 = improvementDigest(input.request);
    const existing = await this.store.findPlanByIdempotencyKey(actor.id, input.idempotencyKey);
    if (existing) {
      if (existing.requestSha256 !== requestSha256) throw idempotencyConflict();
      return { plan: this.planView(existing), created: false };
    }
    const planId = this.id();
    const resolution = await this.resolvePlan(actor, input.request, planId);
    if (!resolution.plan) {
      await this.store.recordAudit(this.audit(actor, "improvement.plan.create", "improvement_plan", null, {
        contextType: input.request.context.type,
        contextId: input.request.context.id,
        blockers: resolution.effectivePolicy.blockers.map((item) => item.code),
      }, "deny"));
      throw improvementError("IMPROVEMENT_POLICY_BLOCKED", "Current policy blocks this improvement plan.", 409, { blockers: resolution.effectivePolicy.blockers });
    }
    const planSha256 = improvementPlanDigest(resolution.plan);
    const record: PlanRecord = {
      id: planId,
      actorUserId: actor.id,
      idempotencyKey: input.idempotencyKey,
      requestSha256,
      request: input.request,
      planSha256,
      plan: resolution.plan,
      effectivePolicy: resolution.effectivePolicy,
      createdAt: resolution.plan.createdAt,
      expiresAt: resolution.plan.expiresAt,
    };
    const result = await this.store.createPlan({
      plan: record,
      audit: this.audit(actor, "improvement.plan.create", "improvement_plan", planId, {
        planSha256,
        contextType: input.request.context.type,
        contextId: input.request.context.id,
        constraintCount: resolution.effectivePolicy.constraints.length,
      }),
    });
    if (!result.created && result.plan.requestSha256 !== requestSha256) throw idempotencyConflict();
    return { plan: this.planView(result.plan), created: result.created };
  }

  async getPlan(actor: ImprovementActor, id: string) {
    const plan = await this.ownedPlan(actor, id);
    const runs = await Promise.all((await this.store.listRunsForPlan(plan.id)).map((run) => this.expireIfDue(actor, run, plan)));
    return { plan: this.planView(plan), runs: runs.map(runView) };
  }

  // ---- Runs -----------------------------------------------------------------------------------

  async createRun(actor: ImprovementActor, planId: string, body: unknown) {
    const plan = await this.ownedPlan(actor, planId);
    const input = contract(() => {
      const record = bodyObject(body, ["planSha256", "idempotencyKey", "runner"]);
      return { planSha256: shaBody(record.planSha256, "planSha256"), idempotencyKey: idempotencyKey(record.idempotencyKey), runner: normalizeImprovementRunnerV1(record.runner) };
    });
    if (input.planSha256 !== plan.planSha256) throw bindingMismatch("The plan digest does not match the server-recorded plan.");
    const runnerSha256 = improvementDigest(input.runner);
    const existingRuns = await this.store.listRunsForPlan(plan.id);
    const replay = existingRuns.find((run) => run.idempotencyKey === input.idempotencyKey);
    if (replay) {
      if (replay.runnerSha256 !== runnerSha256) throw idempotencyConflict();
      return { run: runView(replay), created: false };
    }
    const runs = await Promise.all(existingRuns.map((run) => this.expireIfDue(actor, run, plan)));
    if (this.isExpired(plan)) throw planExpired();
    if (runs.some((run) => run.progress.state === "completed")) {
      throw improvementError("IMPROVEMENT_PLAN_COMPLETED", "This plan already completed. Create a new plan for another run.", 409);
    }
    if (runs.some((run) => run.progress.state === "running")) throw improvementError("IMPROVEMENT_RUN_ACTIVE", "This plan already has an active run.", 409);
    if (runs.length >= plan.plan.policy.maxAttempts) {
      throw improvementError("IMPROVEMENT_ATTEMPTS_EXHAUSTED", "This plan has used all permitted attempts.", 409, { maxAttempts: plan.plan.policy.maxAttempts });
    }
    const missing = improvementRunnerMissingCapabilities(input.runner, plan.plan);
    if (missing.length > 0) {
      throw improvementError("IMPROVEMENT_RUNNER_CAPABILITY_MISSING", "The runner did not declare controls this plan requires.", 422, { missing });
    }
    const recheck = await this.recheckPlan(actor, plan);
    if (recheck) throw recheck;
    const id = this.id();
    const now = this.nowIso();
    const attempt = runs.length + 1;
    const result = await this.store.createRun({
      run: {
        id,
        planId: plan.id,
        planSha256: plan.planSha256,
        actorUserId: actor.id,
        attempt,
        idempotencyKey: input.idempotencyKey,
        runnerSha256,
        runner: input.runner,
        progress: initialImprovementRunProgress(),
        lastSequence: 0,
        version: 1,
        cancellation: "not-requested",
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      },
      audit: this.audit(actor, "improvement.run.create", "improvement_run", id, { planId: plan.id, attempt, adapter: input.runner.adapter }),
    });
    if (!result.created && result.run.runnerSha256 !== runnerSha256) throw idempotencyConflict();
    return { run: runView(result.run), created: result.created };
  }

  async getRun(actor: ImprovementActor, runId: string) {
    const { run, plan } = await this.ownedRun(actor, runId);
    const current = await this.expireIfDue(actor, run, plan);
    return { run: runView(current), events: (await this.store.listRunEvents(current.id)).map(eventView) };
  }

  async appendRunEvent(actor: ImprovementActor, runId: string, body: unknown) {
    const { run, plan } = await this.ownedRun(actor, runId);
    const input = contract(() => {
      const record = bodyObject(body, ["planSha256", "sequence", "event"]);
      if (typeof record.sequence !== "number" || !Number.isInteger(record.sequence) || record.sequence < 1 || record.sequence > 100_000) {
        throw new ImprovementContractError("sequence must be a positive integer.");
      }
      return { planSha256: shaBody(record.planSha256, "planSha256"), sequence: record.sequence, event: normalizeImprovementRunEventV1(record.event) };
    });
    if (input.planSha256 !== run.planSha256) throw bindingMismatch("The plan digest does not match this run.");
    const eventSha256 = improvementDigest(input.event);
    const replayed = await this.replayedEvent(run, input.sequence, eventSha256);
    if (replayed) return replayed;
    if (input.sequence !== run.lastSequence + 1) throw sequenceConflict(run.lastSequence);
    if (run.progress.state !== "running") {
      throw improvementError("IMPROVEMENT_RUN_TERMINAL", "The run is no longer running.", 409, { state: run.progress.state });
    }
    const newer = (await this.store.listRunsForPlan(plan.id)).some((item) => item.attempt > run.attempt);
    if (newer) throw improvementError("IMPROVEMENT_RUN_SUPERSEDED", "A newer attempt supersedes this run.", 409);
    if (this.isExpired(plan)) {
      await this.terminate(actor, run, "expired", "plan_expired");
      throw planExpired();
    }
    if (input.event.type === "stage.started") {
      const recheck = await this.recheckPlan(actor, plan);
      if (recheck) {
        const reason = recheck.code === "IMPROVEMENT_AUTHORIZATION_REVOKED" ? "authorization_revoked"
          : recheck.code === "IMPROVEMENT_PLAN_STALE" ? "plan_stale" : "policy_blocked";
        await this.terminate(actor, run, "failed", reason);
        throw recheck;
      }
    }
    let progress: ImprovementRunProgressV1;
    try {
      progress = applyImprovementRunEvent(run.progress, input.event, { plan: plan.plan, runner: run.runner });
    } catch (error) {
      if (error instanceof ImprovementRunRejection) throw new AppError(error.message, error.code, error.statusCode, error.details);
      throw error;
    }
    const now = this.nowIso();
    const eventRecord: RunEventRecord = {
      id: this.id(),
      runId: run.id,
      sequence: input.sequence,
      type: input.event.type,
      event: input.event,
      eventSha256,
      createdAt: now,
    };
    const terminal = progress.state !== "running";
    try {
      const updated = await this.store.appendRunEvent({
        runId: run.id,
        expectedVersion: run.version,
        event: eventRecord,
        next: { progress, lastSequence: input.sequence, cancellation: run.cancellation, updatedAt: now, completedAt: terminal ? now : null },
        audit: this.audit(actor, "improvement.run.event", "improvement_run", run.id, { sequence: input.sequence, type: input.event.type, state: progress.state }),
      });
      return { run: runView(updated), event: eventView(eventRecord), replayed: false, status: 201 as const };
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "IMPROVEMENT_RUN_CONFLICT") throw error;
      const latest = await this.store.getRun(run.id);
      const concurrent = latest ? await this.replayedEvent(latest, input.sequence, eventSha256) : null;
      if (concurrent) return concurrent;
      throw sequenceConflict(latest?.lastSequence ?? run.lastSequence);
    }
  }

  async cancelRun(actor: ImprovementActor, runId: string, body: unknown) {
    contract(() => {
      const record = bodyObject(body ?? {}, ["reason"]);
      reasonText(record.reason);
    });
    const { run, plan } = await this.ownedRun(actor, runId);
    const current = await this.expireIfDue(actor, run, plan);
    if (current.progress.state === "cancelled") return { run: runView(current) };
    if (current.progress.state !== "running") {
      throw improvementError("IMPROVEMENT_RUN_TERMINAL", "The run is no longer running.", 409, { state: current.progress.state });
    }
    const updated = await this.terminate(actor, current, "cancelled", "cancelled_by_actor");
    return { run: runView(updated) };
  }

  // ---- Evidence -------------------------------------------------------------------------------

  async shareEvidence(actor: ImprovementActor, runId: string, body: unknown) {
    const { run, plan } = await this.ownedRun(actor, runId);
    const input = contract(() => {
      const record = bodyObject(body, ["reportSha256", "disclosure", "proposals", "idempotencyKey"]);
      if (!Array.isArray(record.proposals) || record.proposals.length > 4) throw new ImprovementContractError("proposals must be an array of at most 4 entries.");
      return {
        reportSha256: shaBody(record.reportSha256, "reportSha256"),
        disclosure: enumBody(record.disclosure, "disclosure", ["summary", "selected-evidence"] as const),
        proposals: record.proposals.map((item) => {
          const proposal = bodyObject(item, ["subject", "slug", "version"]);
          return {
            subject: enumBody(proposal.subject, "proposal subject", ["baseline", "candidate"] as const),
            slug: pathParam(stringBody(proposal.slug, "proposal slug")),
            version: pathParam(stringBody(proposal.version, "proposal version")),
          };
        }),
        idempotencyKey: idempotencyKey(record.idempotencyKey),
      };
    });
    const requestSha256 = improvementDigest({ runId: run.id, reportSha256: input.reportSha256, disclosure: input.disclosure, proposals: input.proposals });
    const existing = await this.store.findEvidenceByIdempotencyKey(actor.id, input.idempotencyKey);
    if (existing) {
      if (existing.requestSha256 !== requestSha256) throw idempotencyConflict();
      return { evidence: await this.evidenceView(existing), created: false };
    }
    if (run.progress.state !== "completed" || !run.progress.report || !run.progress.reportSha256) {
      throw improvementError("IMPROVEMENT_RUN_NOT_COMPLETED", "Only completed runs can share evidence.", 409);
    }
    if (input.reportSha256 !== run.progress.reportSha256) throw bindingMismatch("The report digest does not match this run.");
    if (improvementDisclosureRank(input.disclosure) > improvementDisclosureRank(plan.plan.resultSharing)) throw disclosureNotAllowed("The plan did not allow this disclosure.");
    const current = await this.resolvePlanSafely(actor, plan);
    if (!current || current.unavailable || current.effectivePolicy.status !== "allowed"
      || improvementDisclosureRank(input.disclosure) > improvementDisclosureRank(current.effectivePolicy.maxDisclosure)) {
      throw disclosureNotAllowed("Current policy does not allow this disclosure.");
    }
    const proposals: EvidenceProposal[] = [];
    for (const proposal of input.proposals) {
      const release = await this.resolveRelease(actor, proposal.slug, proposal.version);
      const expected = proposal.subject === "baseline" ? baselineTree(plan.plan, proposal) : run.progress.candidate?.treeSha256 ?? null;
      if (!release || !usable(release) || !expected || release.artifactSha256 !== expected) {
        throw bindingMismatch("Evidence can only be proposed to a release whose artifact equals the tested tree.");
      }
      // Local sources can have no parent or an unrelated parent. The actual destination's owners
      // must still permit disclosure, independently of the scopes used when planning.
      await this.assertDestinationDisclosure(release.slug, input.disclosure);
      if (proposals.some((item) => item.releaseId === release.releaseId && item.subject === proposal.subject)) continue;
      proposals.push({ subject: proposal.subject, releaseId: release.releaseId, slug: release.slug, version: release.version, artifactSha256: release.artifactSha256 });
    }
    const summary = buildImprovementEvidenceSummaryV1({
      plan: plan.plan,
      progress: run.progress,
      report: run.progress.report,
      disclosure: input.disclosure,
      completedAt: run.completedAt ?? run.updatedAt,
    });
    const provenance = "local-report" as const;
    const evidenceSha256 = improvementDigest({
      schemaVersion: 1,
      runId: run.id,
      planSha256: plan.planSha256,
      reportSha256: run.progress.reportSha256,
      provenance,
      summary,
      proposals: proposals.map(({ subject, releaseId, artifactSha256 }) => ({ subject, releaseId, artifactSha256 })),
    });
    const id = this.id();
    const result = await this.store.createEvidence({
      evidence: {
        id,
        runId: run.id,
        planId: plan.id,
        reporterUserId: actor.id,
        context: plan.plan.context,
        idempotencyKey: input.idempotencyKey,
        requestSha256,
        disclosure: input.disclosure,
        provenance,
        summary,
        evidenceSha256,
        proposals,
        createdAt: this.nowIso(),
      },
      audit: this.audit(actor, "improvement.evidence.share", "improvement_evidence", id, {
        runId: run.id, disclosure: input.disclosure, proposalCount: proposals.length, evidenceSha256,
      }),
    });
    if (!result.created && result.evidence.requestSha256 !== requestSha256) throw idempotencyConflict();
    return { evidence: await this.evidenceView(result.evidence), created: result.created };
  }

  async getEvidence(actor: ImprovementActor, id: string) {
    const evidence = await this.store.getEvidence(pathParam(id));
    if (!evidence) throw improvementNotFound();
    if (evidence.reporterUserId !== actor.id) {
      let manager = false;
      for (const proposal of evidence.proposals) {
        const release = await this.resolveRelease(actor, proposal.slug, proposal.version);
        if (release?.canManage) manager = true;
      }
      if (!manager) throw improvementNotFound();
    }
    return { evidence: await this.evidenceView(evidence) };
  }

  async decideEvidence(actor: ImprovementActor, id: string, body: unknown) {
    const input = contract(() => {
      const record = bodyObject(body, ["slug", "version", "subject", "evidenceSha256", "decision", "reason"]);
      return {
        slug: pathParam(stringBody(record.slug, "slug")),
        version: pathParam(stringBody(record.version, "version")),
        subject: enumBody(record.subject, "subject", ["baseline", "candidate"] as const),
        evidenceSha256: shaBody(record.evidenceSha256, "evidenceSha256"),
        decision: enumBody(record.decision, "decision", ["accept", "reject"] as const),
        reason: reasonText(record.reason),
      };
    });
    const evidence = await this.store.getEvidence(pathParam(id));
    if (!evidence) throw improvementNotFound();
    const release = await this.resolveRelease(actor, input.slug, input.version);
    if (!release) throw releaseNotFound();
    if (!release.canManage) throw releaseManagerRequired();
    requireMfa(actor);
    const proposal = evidence.proposals.find((item) => item.releaseId === release.releaseId && item.subject === input.subject);
    if (!proposal) throw bindingMismatch("This evidence was not proposed for this release and subject.");
    if (input.evidenceSha256 !== evidence.evidenceSha256) throw bindingMismatch("The evidence digest does not match.");
    if (proposal.artifactSha256 !== release.artifactSha256) throw bindingMismatch("The release artifact no longer matches the tested tree.");
    if (input.decision === "accept") await this.assertEvidenceStillDisclosable(evidence, release.slug);
    const acceptanceId = this.id();
    const acceptance = await this.store.createAcceptance({
      acceptance: {
        id: acceptanceId,
        evidenceId: evidence.id,
        releaseId: release.releaseId,
        subject: input.subject,
        evidenceSha256: evidence.evidenceSha256,
        decision: input.decision,
        provenance: evidence.provenance,
        actorUserId: actor.id,
        reason: input.reason,
        createdAt: this.nowIso(),
      },
      audit: this.audit(actor, `improvement.evidence.${input.decision}`, "improvement_evidence_acceptance", acceptanceId, {
        evidenceId: evidence.id, releaseId: release.releaseId, subject: input.subject, evidenceSha256: evidence.evidenceSha256,
      }),
    });
    return {
      acceptance: {
        id: acceptance.id,
        evidenceId: acceptance.evidenceId,
        slug: release.slug,
        version: release.version,
        subject: acceptance.subject,
        decision: acceptance.decision,
        provenance: acceptance.provenance,
        createdAt: acceptance.createdAt,
      },
    };
  }

  // ---- Internals ------------------------------------------------------------------------------

  private async assertEvidenceStillDisclosable(evidence: EvidenceRecord, destinationSlug: string): Promise<void> {
    // Recheck as the reporter using current account roles, not as the deciding manager.
    // This identity is used only for reads; the authenticated manager remains the audit actor.
    const user = await this.deps.authStore.findUserById(evidence.reporterUserId);
    const reporter = user?.status === "active" && user.emailVerifiedAt
      ? { id: user.id, email: user.email, name: user.name, roles: user.roles, mfaVerified: false }
      : null;
    const plan = await this.store.getPlan(evidence.planId);
    const current = reporter && plan?.actorUserId === reporter.id
      ? await this.resolvePlanSafely(reporter, plan)
      : null;
    // Match the sharing gate. Execution expiry and harmless policy revision changes do not
    // invalidate a completed report, but current access and disclosure must still permit it.
    if (!current || current.unavailable || current.effectivePolicy.status !== "allowed"
      || improvementDisclosureRank(evidence.disclosure) > improvementDisclosureRank(current.effectivePolicy.maxDisclosure)) {
      throw disclosureNotAllowed("Current permissions or policy do not allow this evidence disclosure.");
    }
    await this.assertDestinationDisclosure(destinationSlug, evidence.disclosure);
  }

  private async assertDestinationDisclosure(slug: string, disclosure: EvidenceRecord["disclosure"]): Promise<void> {
    for (const { scope } of await this.resourceScopes(slug, "subject-resource")) {
      const destination = await this.store.getLatestPolicy(scope);
      if (!destination?.policy.enabled
        || improvementDisclosureRank(disclosure) > improvementDisclosureRank(destination.policy.maxDisclosure)) {
        throw disclosureNotAllowed("A destination owner has not enabled this evidence disclosure.");
      }
    }
  }

  private async resolvePlan(actor: ImprovementActor, request: ImprovementPlanRequestV1, planId: string): Promise<PlanResolution> {
    const contextRole = await this.scopeRole(actor, request.context);
    if (!contextRole) throw improvementNotFound();
    const blockers: ImprovementPolicyBlocker[] = [];
    const scopes: Array<{ scope: ImprovementScopeRef; reason: ImprovementConstraintReason }> = [{ scope: request.context, reason: "run-context" }];
    if (request.context.type === "team") {
      const parent = await this.teamOrganization(actor, request.context.id);
      if (parent) scopes.push({ scope: { type: "organization", id: parent }, reason: "parent-organization" });
    }

    const sourcePin = request.source.kind === "release" ? request.source : request.source.parent;
    let sourceReleaseId: string | null = null;
    if (sourcePin) {
      const release = await this.resolveRelease(actor, sourcePin.slug, sourcePin.version);
      if (!release || !usable(release) || release.artifactSha256 !== sourcePin.artifactSha256) {
        blockers.push({ code: "SOURCE_UNAVAILABLE", source: null, message: "The source release is unavailable or its artifact digest changed." });
      } else {
        sourceReleaseId = release.releaseId;
      }
      scopes.push(...(await this.resourceScopes(sourcePin.slug, "subject-resource")));
    }

    const reviewerReleaseIds: string[] = [];
    for (const pin of request.reviewers) {
      const release = await this.resolveRelease(actor, pin.slug, pin.version);
      if (!release || !usable(release) || release.artifactSha256 !== pin.artifactSha256) {
        blockers.push({ code: "REVIEWER_UNAVAILABLE", source: null, message: `Reviewer ${pin.slug}@${pin.version} is unavailable or its artifact digest changed.` });
      }
      reviewerReleaseIds.push(release?.releaseId ?? "");
      if (pin.slug === sourcePin?.slug || pin.slug === request.candidate.identity?.slug) {
        blockers.push({ code: "REVIEWER_CYCLE", source: null, message: "A reviewer cannot review or improve itself." });
      }
      scopes.push(...(await this.resourceScopes(pin.slug, "reviewer-resource")));
    }

    const profile = await this.readableRevision(actor, "profile", request.profileRevisionId);
    if (!profile) {
      blockers.push({ code: "PROFILE_UNAVAILABLE", source: null, message: "The target profile revision is unavailable." });
    } else {
      scopes.push(...(await this.ownerScopes(actor, profile.document.owner, "profile-resource")));
      const target = (profile.revision.body as ImprovementTargetProfileV1).target;
      if (target.model.provider !== request.dataRoute.provider || target.model.id !== request.dataRoute.model) {
        blockers.push({ code: "PROFILE_ROUTE_MISMATCH", source: null, message: "The inference route model differs from the target profile model." });
      }
    }
    const suite = request.suiteRevisionId ? await this.readableRevision(actor, "suite", request.suiteRevisionId) : null;
    if (request.suiteRevisionId && !suite) {
      blockers.push({ code: "SUITE_UNAVAILABLE", source: null, message: "The evaluation suite revision is unavailable." });
    } else if (suite) {
      scopes.push(...(await this.ownerScopes(actor, suite.document.owner, "suite-resource")));
    }

    const constraints: ImprovementPolicyConstraintInput[] = [];
    const seen = new Set<string>();
    for (const { scope, reason } of scopes) {
      const key = `${scope.type}:${scope.id}:${reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const revision = await this.store.getLatestPolicy(scope);
      constraints.push({
        source: scope,
        reason,
        revisionId: revision?.id ?? null,
        revisionNumber: revision?.revisionNumber ?? 0,
        policySha256: revision?.policySha256 ?? null,
        policy: revision?.policy ?? null,
      });
    }
    const effectivePolicy = composeImprovementPolicies(constraints, {
      reviewers: request.reviewers,
      inference: request.dataRoute.inference,
      provider: request.dataRoute.provider,
      model: request.dataRoute.model,
      resultSharing: request.resultSharing,
      budget: request.budget,
      expiresInMinutes: request.expiresInMinutes,
      maxCandidates: request.candidate.maxCandidates,
      objectives: request.goals.objectives,
    }, blockers);
    const suiteBody = suite ? suite.revision.body as ImprovementEvaluationSuiteV1 : null;
    if (suiteBody?.graders.includes("model") && !hasIndependentEvaluator(request.reviewers)) {
      effectivePolicy.warnings.push({
        code: "INDEPENDENT_EVALUATOR_MISSING",
        source: null,
        message: "Model grading without an independent evaluate reviewer cannot support a measured claim.",
      });
    }
    const unavailable = effectivePolicy.blockers.some((item) => unavailableCodes.has(item.code));
    if (effectivePolicy.status !== "allowed" || !profile || !sourceReleaseIdOk(request, sourceReleaseId)) {
      return { effectivePolicy, plan: null, unavailable };
    }
    const createdAt = this.now();
    const profileBody = profile.revision.body as ImprovementTargetProfileV1;
    const plan: ImprovementPlanV1 = {
      schemaVersion: 1,
      id: planId,
      actorUserId: actor.id,
      context: request.context,
      source: request.source.kind === "release"
        ? { ...request.source, releaseId: sourceReleaseId ?? "" }
        : { kind: "local", treeSha256: request.source.treeSha256, parent: request.source.parent ? { ...request.source.parent, releaseId: sourceReleaseId ?? "" } : null },
      reviewers: request.reviewers.map((pin, index) => ({ ...pin, releaseId: reviewerReleaseIds[index] ?? "" })),
      profile: {
        profileId: profile.document.id,
        revisionId: profile.revision.id,
        revisionNumber: profile.revision.revisionNumber,
        profileSha256: profile.revision.bodySha256,
        target: profileBody.target,
        settings: profileBody.settings,
      },
      suite: suite && suiteBody
        ? {
          suiteId: suite.document.id,
          revisionId: suite.revision.id,
          revisionNumber: suite.revision.revisionNumber,
          documentSha256: suite.revision.bodySha256,
          suiteSha256: suiteBody.contentSha256,
          rubricSha256: suiteBody.rubricSha256,
          caseCount: suiteBody.caseCount,
          protectedCaseCount: suiteBody.protectedCaseCount,
          holdoutCaseCount: suiteBody.holdoutCaseCount,
          graders: suiteBody.graders,
          repetitions: suiteBody.repetitions,
        }
        : null,
      goals: {
        objectives: request.goals.objectives.length > 0 ? request.goals.objectives : effectivePolicy.defaults.objectives,
        protectedRequirements: [...new Set([...request.goals.protectedRequirements, ...effectivePolicy.protectedRequirements, ...profileBody.protectedRequirements])],
      },
      guidance: request.guidance,
      candidate: request.candidate,
      budget: request.budget,
      dataRoute: request.dataRoute,
      resultSharing: request.resultSharing,
      policy: {
        effectiveSha256: improvementEffectivePolicyDigest(effectivePolicy),
        constraints: effectivePolicy.constraints,
        requiredChecks: effectivePolicy.requiredChecks,
        maxDisclosure: effectivePolicy.maxDisclosure,
        minimumProvenance: effectivePolicy.minimumProvenance,
        maxAttempts: effectivePolicy.limits.maxAttempts,
      },
      localExecution: { consent: "required-local", enforcement: "cooperative-local-coordinator" },
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + request.expiresInMinutes * 60_000).toISOString(),
    };
    return { effectivePolicy, plan, unavailable };
  }

  /** Re-resolve the recorded request under current state. Null means the plan is still valid. */
  private async recheckPlan(actor: ImprovementActor, plan: PlanRecord): Promise<AppError | null> {
    const current = await this.resolvePlanSafely(actor, plan);
    if (!current || current.unavailable) {
      return improvementError("IMPROVEMENT_AUTHORIZATION_REVOKED", "Access to a plan input was revoked or changed.", 409);
    }
    if (constraintKey(current.effectivePolicy.constraints) !== constraintKey(plan.plan.policy.constraints)) {
      return improvementError("IMPROVEMENT_PLAN_STALE", "An applicable policy changed after planning. Create a new plan.", 409);
    }
    if (current.effectivePolicy.status !== "allowed") {
      return improvementError("IMPROVEMENT_POLICY_BLOCKED", "Current policy blocks this improvement plan.", 409, { blockers: current.effectivePolicy.blockers });
    }
    return null;
  }

  private async resolvePlanSafely(actor: ImprovementActor, plan: PlanRecord): Promise<PlanResolution | null> {
    try {
      return await this.resolvePlan(actor, plan.request, plan.id);
    } catch (error) {
      if (error instanceof AppError && (error.statusCode === 403 || error.statusCode === 404)) return null;
      throw error;
    }
  }

  private async resolveRelease(actor: ImprovementActor | null, slug: string, version: string): Promise<ResolvedRelease | null> {
    const submissionActor = actor ? { id: actor.id, roles: actor.roles } : null;
    const releases = await this.deps.submissionService.listSkillReleases({ slug, actor: submissionActor });
    const release = releases.find((item) => item.version === version);
    if (!release) return null;
    let canManage = false;
    if (submissionActor) {
      try {
        canManage = Boolean(await this.deps.submissionService.getSkillManagement({ actor: submissionActor, slug }));
      } catch (error) {
        if (!(error instanceof AppError) || (error.statusCode !== 403 && error.statusCode !== 404)) throw error;
      }
    }
    return {
      releaseId: release.id,
      slug: release.slug,
      version: release.version,
      artifactSha256: release.artifact.sha256,
      published: Boolean(release.publishedAt),
      lifecycleStatus: release.lifecycleStatus,
      canManage,
    };
  }

  /** Active sharing scopes only: team grants for team visibility, organization grants for organization visibility. */
  private async resourceScopes(slug: string, reason: ImprovementConstraintReason): Promise<Array<{ scope: ImprovementScopeRef; reason: ImprovementConstraintReason }>> {
    const governance = await this.store.getSkillGovernance(slug);
    if (!governance) return [];
    const scopes: Array<{ scope: ImprovementScopeRef; reason: ImprovementConstraintReason }> = [];
    if (governance.visibility === "team") {
      for (const team of governance.teams) {
        scopes.push({ scope: { type: "team", id: team.id }, reason });
        if (team.organizationId) scopes.push({ scope: { type: "organization", id: team.organizationId }, reason });
      }
    }
    if (governance.visibility === "organization") {
      for (const organizationId of governance.organizationIds) scopes.push({ scope: { type: "organization", id: organizationId }, reason });
    }
    return scopes;
  }

  private async ownerScopes(actor: ImprovementActor, owner: ImprovementScopeRef, reason: ImprovementConstraintReason) {
    if (owner.type === "user") return [];
    const scopes: Array<{ scope: ImprovementScopeRef; reason: ImprovementConstraintReason }> = [{ scope: owner, reason }];
    if (owner.type === "team") {
      const parent = await this.teamOrganization(actor, owner.id);
      if (parent) scopes.push({ scope: { type: "organization", id: parent }, reason });
    }
    return scopes;
  }

  private async readableRevision(actor: ImprovementActor, kind: ImprovementDocumentKind, revisionId: string): Promise<{ document: DocumentRecord; revision: DocumentRevisionRecord } | null> {
    const document = await this.store.getDocumentByRevision(revisionId);
    if (!document || document.kind !== kind || !await this.scopeRole(actor, document.owner)) return null;
    const revision = document.revisions.find((item) => item.id === revisionId);
    return revision ? { document, revision } : null;
  }

  private async scopeRole(actor: ImprovementActor, scope: ImprovementScopeRef): Promise<ScopeRole | null> {
    if (scope.type === "user") return scope.id === actor.id ? "owner" : null;
    if (scope.type === "team") {
      if (!this.deps.teamService) return null;
      const dashboard = await this.deps.teamService.listDashboard({ id: actor.id, email: actor.email });
      const team = dashboard.teams.find((item) => item.id === scope.id);
      if (!team) return null;
      if (team.organizationId && !await this.organizationRole(actor, team.organizationId)) return null;
      return team.role;
    }
    return this.organizationRole(actor, scope.id);
  }

  private async organizationRole(actor: ImprovementActor, organizationId: string): Promise<ScopeRole | null> {
    if (!this.deps.organizationService) return null;
    try {
      const organization = await this.deps.organizationService.getOrganization({ id: actor.id, email: actor.email, name: actor.name }, organizationId);
      return organization?.role ?? null;
    } catch (error) {
      if (error instanceof AppError && error.statusCode < 500) return null;
      throw error;
    }
  }

  private async teamOrganization(actor: ImprovementActor, teamId: string): Promise<string | null> {
    if (!this.deps.teamService) return null;
    const dashboard = await this.deps.teamService.listDashboard({ id: actor.id, email: actor.email });
    return dashboard.teams.find((item) => item.id === teamId)?.organizationId ?? null;
  }

  private async requireReader(actor: ImprovementActor, scope: ImprovementScopeRef): Promise<ScopeRole> {
    const role = await this.scopeRole(actor, scope);
    if (!role) throw improvementNotFound();
    return role;
  }

  private async requireWriter(actor: ImprovementActor, scope: ImprovementScopeRef): Promise<void> {
    const role = await this.requireReader(actor, scope);
    const writer = scope.type === "user" || (scope.type === "team" ? role === "owner" : role === "owner" || role === "admin");
    if (!writer) throw scopeForbidden();
    if (scope.type !== "user") requireMfa(actor);
  }

  private async ownedPlan(actor: ImprovementActor, id: string): Promise<PlanRecord> {
    const plan = await this.store.getPlan(pathParam(id));
    if (!plan || plan.actorUserId !== actor.id) throw improvementNotFound();
    return plan;
  }

  private async ownedRun(actor: ImprovementActor, id: string): Promise<{ run: RunRecord; plan: PlanRecord }> {
    const run = await this.store.getRun(pathParam(id));
    if (!run || run.actorUserId !== actor.id) throw improvementNotFound();
    const plan = await this.store.getPlan(run.planId);
    if (!plan) throw improvementNotFound();
    return { run, plan };
  }

  private async replayedEvent(run: RunRecord, sequence: number, eventSha256: string) {
    if (sequence > run.lastSequence) return null;
    const stored = (await this.store.listRunEvents(run.id)).find((item) => item.sequence === sequence);
    if (!stored || stored.eventSha256 !== eventSha256) throw sequenceConflict(run.lastSequence);
    return { run: runView(run), event: eventView(stored), replayed: true, status: 200 as const };
  }

  private async expireIfDue(actor: ImprovementActor, run: RunRecord, plan: PlanRecord): Promise<RunRecord> {
    if (run.progress.state !== "running" || !this.isExpired(plan)) return run;
    try {
      return await this.terminate(actor, run, "expired", "plan_expired");
    } catch (error) {
      if (error instanceof AppError && error.code === "IMPROVEMENT_RUN_CONFLICT") return (await this.store.getRun(run.id)) ?? run;
      throw error;
    }
  }

  private async terminate(
    actor: ImprovementActor,
    run: RunRecord,
    state: "failed" | "cancelled" | "expired",
    reason: "plan_expired" | "plan_stale" | "authorization_revoked" | "policy_blocked" | "cancelled_by_actor",
  ): Promise<RunRecord> {
    const now = this.nowIso();
    const next: RunMutation = {
      progress: { ...run.progress, state, openStage: null, terminalReason: reason },
      lastSequence: run.lastSequence,
      cancellation: state === "cancelled" ? (run.runner.capabilities.cancellation ? "requested" : "requested-unconfirmed") : run.cancellation,
      updatedAt: now,
      completedAt: now,
    };
    const action = state === "cancelled" ? "improvement.run.cancel" : state === "expired" ? "improvement.run.expire" : "improvement.run.fail";
    return this.store.updateRun({
      runId: run.id,
      expectedVersion: run.version,
      next,
      audit: this.audit(actor, action, "improvement_run", run.id, { terminalReason: reason }),
    });
  }

  private async acceptedEvidence(release: ResolvedRelease): Promise<ReleaseCompatibilityProjectionV1["evidence"]> {
    const acceptances = (await this.store.listAcceptances({ releaseId: release.releaseId })).filter((item) => item.decision === "accept");
    const items: ReleaseCompatibilityProjectionV1["evidence"] = [];
    for (const acceptance of acceptances) {
      const evidence = await this.store.getEvidence(acceptance.evidenceId);
      const proposal = evidence?.proposals.find((item) => item.releaseId === release.releaseId && item.subject === acceptance.subject);
      if (!evidence || !proposal || proposal.artifactSha256 !== release.artifactSha256 || acceptance.evidenceSha256 !== evidence.evidenceSha256) continue;
      const profile = await this.store.getDocument(evidence.summary.profile.profileId);
      const relevance = profile?.latest.id === evidence.summary.profile.revisionId ? "current" as const : "stale" as const;
      const claim = deriveImprovementEvidenceClaim({
        subject: acceptance.subject,
        summary: evidence.summary,
        provenance: evidence.provenance,
        accepted: true,
        relevance,
      });
      items.push({
        evidenceId: evidence.id,
        subject: acceptance.subject,
        acceptedAt: acceptance.createdAt,
        provenance: evidence.provenance,
        profile: { profileId: evidence.summary.profile.profileId, revisionNumber: evidence.summary.profile.revisionNumber, target: evidence.summary.profile.target },
        relevance,
        suite: evidence.summary.suite
          ? { caseCount: evidence.summary.suite.caseCount, protectedCaseCount: evidence.summary.suite.protectedCaseCount, holdoutCaseCount: evidence.summary.suite.holdoutCaseCount }
          : null,
        evaluation: evidence.summary.evaluations,
        claim: claim.claim,
        unmetConditions: claim.unmetConditions,
      });
    }
    return items;
  }

  private async evidenceView(evidence: EvidenceRecord) {
    const acceptances = await this.store.listAcceptances({ evidenceId: evidence.id });
    return {
      id: evidence.id,
      runId: evidence.runId,
      planId: evidence.planId,
      reporterUserId: evidence.reporterUserId,
      context: evidence.context,
      disclosure: evidence.disclosure,
      provenance: evidence.provenance,
      summary: evidence.summary,
      evidenceSha256: evidence.evidenceSha256,
      proposals: evidence.proposals.map(({ subject, slug, version, artifactSha256 }) => ({ subject, slug, version, artifactSha256 })),
      acceptances: acceptances.map((item) => {
        const proposal = evidence.proposals.find((candidate) => candidate.releaseId === item.releaseId && candidate.subject === item.subject);
        return { subject: item.subject, slug: proposal?.slug ?? null, version: proposal?.version ?? null, decision: item.decision, createdAt: item.createdAt };
      }),
      createdAt: evidence.createdAt,
    };
  }

  private planView(plan: PlanRecord) {
    return {
      id: plan.id,
      planSha256: plan.planSha256,
      plan: plan.plan,
      effectivePolicy: plan.effectivePolicy,
      status: this.isExpired(plan) ? "expired" as const : "active" as const,
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
    };
  }

  private isExpired(plan: Pick<PlanRecord, "expiresAt">): boolean {
    return this.now().getTime() >= Date.parse(plan.expiresAt);
  }

  private audit(
    actor: ImprovementActor,
    action: string,
    resourceType: string,
    resourceId: string | null,
    details: Record<string, unknown>,
    decision: "allow" | "deny" = "allow",
  ): ImprovementAuditInput {
    return { actorUserId: actor.id, action, decision, resourceType, resourceId, details };
  }

  private id(): string {
    return this.options.idFactory?.() ?? randomUUID();
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

function currentApproved(revisions: DeclarationRevisionRecord[], kind: "declaration" | "attestation", release: ResolvedRelease): DeclarationRevisionRecord | null {
  const current = revisions.filter((item) => item.kind === kind).sort((left, right) => right.revisionNumber - left.revisionNumber)[0];
  return current && declarationApprovalMatches(current, release) ? current : null;
}

function publicRevision(revision: DeclarationRevisionRecord, withIssuer: boolean): ReleaseCompatibilityRevisionV1 {
  return {
    id: revision.id,
    revisionNumber: revision.revisionNumber,
    kind: revision.kind,
    declaration: revision.declaration,
    declarationSha256: revision.declarationSha256,
    approvedAt: revision.review?.createdAt ?? "",
    approvalBindingSha256: revision.review?.bindingSha256 ?? "",
    ...(withIssuer ? { issuerUserId: revision.createdByUserId } : {}),
    createdAt: revision.createdAt,
  };
}

function revisionView(revision: DeclarationRevisionRecord): Record<string, unknown> {
  return { ...revision };
}

function documentView(document: DocumentRecord) {
  return { ...document };
}

function runView(run: RunRecord) {
  return {
    id: run.id,
    planId: run.planId,
    planSha256: run.planSha256,
    attempt: run.attempt,
    state: run.progress.state,
    openStage: run.progress.openStage,
    completedStages: run.progress.completedStages,
    lastSequence: run.lastSequence,
    runner: run.runner,
    provenance: "local-report" as const,
    candidate: run.progress.candidate,
    evaluations: run.progress.evaluations,
    report: run.progress.report,
    reportSha256: run.progress.reportSha256,
    terminalReason: run.progress.terminalReason,
    cancellation: run.cancellation,
    guarantees: improvementRunGuarantees(run.runner),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  };
}

function eventView(event: RunEventRecord) {
  return { id: event.id, sequence: event.sequence, type: event.type, eventSha256: event.eventSha256, event: event.event, createdAt: event.createdAt };
}

/** Baseline evidence binds to the named source release, or to any release with the exact local tree bytes. */
function baselineTree(plan: ImprovementPlanV1, proposal: { slug: string; version: string }): string | null {
  if (plan.source.kind === "release" && (plan.source.slug !== proposal.slug || plan.source.version !== proposal.version)) return null;
  return improvementPlanSourceTreeSha256(plan);
}

function sourceReleaseIdOk(request: ImprovementPlanRequestV1, releaseId: string | null): boolean {
  const pinned = request.source.kind === "release" || request.source.parent !== null;
  return !pinned || releaseId !== null;
}

function usable(release: ResolvedRelease): boolean {
  return release.published && (release.lifecycleStatus === "approved" || release.lifecycleStatus === "deprecated");
}

function constraintKey(constraints: readonly ImprovementPolicyConstraintV1[]): string {
  return constraints.map((item) => `${item.source.type}:${item.source.id}:${item.revisionId ?? "none"}`).sort().join("|");
}

function canReview(actor: ImprovementActor): boolean {
  return actor.roles.some((role) => role === "owner" || role === "admin" || role === "maintainer");
}

function requireMfa(actor: ImprovementActor): void {
  if (!actor.mfaVerified) throw improvementError("MFA_VERIFICATION_REQUIRED", "MFA verification is required.", 403);
}

function contract<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ImprovementContractError) throw improvementError("INVALID_IMPROVEMENT_REQUEST", error.message, 400);
    throw error;
  }
}

function bodyObject(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ImprovementContractError("Request body must be a JSON object.");
  const record = input as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new ImprovementContractError(`Request field is not accepted: ${unknown}`);
  return record;
}

function normalizeDocument(kind: ImprovementDocumentKind, input: unknown) {
  return kind === "profile" ? normalizeImprovementTargetProfileV1(input) : normalizeImprovementEvaluationSuiteV1(input);
}

function expectedRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new ImprovementContractError("expectedRevisionNumber must be a non-negative integer.");
  }
  return value;
}

function reasonText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) throw new ImprovementContractError("reason is invalid.");
  return value.trim();
}

function idempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !idempotencyKeyPattern.test(value)) throw new ImprovementContractError("idempotencyKey is invalid.");
  return value;
}

function shaBody(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new ImprovementContractError(`${field} must be a lowercase SHA-256 digest.`);
  return value;
}

function stringBody(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ImprovementContractError(`${field} must be a string.`);
  return value;
}

function enumBody<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new ImprovementContractError(`${field} is invalid.`);
  return value as T;
}

function pathParam(value: string): string {
  if (typeof value !== "string" || !pathIdPattern.test(value)) throw improvementNotFound();
  return value;
}

function releaseNotFound(): AppError {
  return improvementError("RELEASE_NOT_FOUND", "Release not found.", 404);
}

function releaseManagerRequired(): AppError {
  return improvementError("IMPROVEMENT_RELEASE_MANAGER_REQUIRED", "Only the release owner or a maintainer can do this.", 403);
}

function bindingMismatch(message: string): AppError {
  return improvementError("IMPROVEMENT_BINDING_MISMATCH", message, 422);
}

function disclosureNotAllowed(message: string): AppError {
  return improvementError("IMPROVEMENT_DISCLOSURE_NOT_ALLOWED", message, 422);
}

function sequenceConflict(lastSequence: number): AppError {
  return improvementError("IMPROVEMENT_EVENT_SEQUENCE_CONFLICT", "The event sequence does not follow the run.", 409, { lastSequence });
}

function planExpired(): AppError {
  return improvementError("IMPROVEMENT_PLAN_EXPIRED", "The plan expired. Create a new plan.", 409);
}
