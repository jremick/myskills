import { createHash } from "node:crypto";
import {
  AppError,
  architectureSyncOrderedDigest,
  architectureSyncPlanDigest,
  architectureSyncSnapshotDigest,
  architectureSyncStepIdempotencyKey,
  architectureTargetAdapterDigest,
  architectureTargetCapabilitiesDigest,
  assertValidArchitectureSyncRun,
  compileArchitecture,
  canonicalizeJson,
  planArchitectureSync,
  validateArchitectureTargetObservation,
  type ArchitectureSyncMetadata,
  type ArchitectureSyncRun,
  type ArchitectureSyncStep,
} from "@myskills-app/core";
import { resolveAuthorizedArchitectureRegistry, type ExactReleaseResolutionDependencies } from "../architectures/exact-release-authorizer.js";
import type { ArchitectureStore, ArchitectureRecord, ArchitectureRevisionRecord } from "../architectures/types.js";
import type { ArchitectureTargetRecord, ArchitectureTargetStore } from "../targets/types.js";
import type { ArchitectureSyncStore } from "./types.js";
import { sanitizeArchitectureSyncMetadata } from "./metadata.js";

export interface ArchitecturePlanActor { readonly id: string; readonly mfaVerified: boolean; readonly artifactCredential?: { readonly kind: "session" | "api_token" | "oauth"; readonly hash: string; readonly resource?: string; readonly clientId?: string; readonly requiredScopes?: readonly string[] } }
export interface CreateArchitecturePlanInput {
  readonly revisionId: string;
  readonly expectedTargetGeneration: number;
  readonly expectedObservationId: string;
  readonly expectedObservationDigest: string;
  readonly idempotencyKey: string;
}
export interface ArchitecturePlanDependencies {
  readonly architectureStore: ArchitectureStore;
  readonly targetStore: ArchitectureTargetStore;
  readonly releaseDependencies: ExactReleaseResolutionDependencies;
  readonly authorityNow?: () => Promise<Date>;
  readonly assertArtifactCredential?: (actor: ArchitecturePlanActor, execution: boolean, purpose?: "review" | "intent") => Promise<void>;
  readonly artifactSubmissions?: Pick<import("../submissions/service.js").SubmissionService, "getPublicBundle" | "getPublicRelease" | "listSkillReleaseChangeHistory">;
  readonly readPolicyConstraints?: (target: ArchitectureTargetRecord) => Promise<unknown>;
  readonly authorizeRevision?: (input: { actorId: string; target: ArchitectureTargetRecord; architecture: ArchitectureRecord; revision: ArchitectureRevisionRecord }) => Promise<void>;
}

/** Persisted review intent only. This service has no executor or target writer. */
export class ArchitecturePlanService {
  private readonly now: () => Date;
  constructor(private readonly store: ArchitectureSyncStore, private readonly dependencies: ArchitecturePlanDependencies, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async createPlan(actor: ArchitecturePlanActor, targetId: string, input: CreateArchitecturePlanInput) {
    validateCreateArchitecturePlanInput(input);
    if (this.store.withPlanAuthority) return this.store.withPlanAuthority({ actorId: actor.id, targetId }, (store, dependencies) => new ArchitecturePlanService(store, dependencies, { now: this.now }).createWithinAuthority(actor, targetId, input));
    return this.createWithinAuthority(actor, targetId, input);
  }

  private async createWithinAuthority(actor: ArchitecturePlanActor, targetId: string, input: CreateArchitecturePlanInput) {
    const target = await this.requireTarget(actor, targetId, true);
    requireMfa(actor);
    assertGeneration(target, input.expectedTargetGeneration);
    const snapshot = await this.snapshot(actor, target, input.revisionId);
    if (snapshot.observation.id !== input.expectedObservationId || snapshot.observation.observedDigest !== input.expectedObservationDigest) {
      throw stale("OBSERVATION", "The selected target observation is no longer current.");
    }
    const requestId = digestIdentifier({ actorId: actor.id, targetId, key: input.idempotencyKey });
    const existing = await this.store.findRunForCreate({ actorId: actor.id, requestKey: `architecture-plan-${requestId}`, targetId, idempotencyKey: `architecture-plan-${requestId}` });
    const legacyIds = Boolean(existing?.steps.length && existing.steps.every((step, index) => step.id === `step-${index + 1}`));
    const identity = { schemaVersion: 1 as const, runId: `architecture-plan-${requestId}`, targetId: target.id, targetGeneration: target.generation, architectureId: target.architectureId, revisionId: input.revisionId, profileId: target.profileId, environmentId: target.environmentId };
    const placeholderSteps: ArchitectureSyncStep[] = snapshot.plan.items.map((item, index) => ({ schemaVersion: 1, id: legacyIds ? `step-${index + 1}` : `step-${requestId}-${index + 1}`, ordinal: index + 1, action: item.action, nodeId: item.nodeId, targetGeneration: target.generation, state: "planned", idempotencyKey: "pending", metadata: { kind: item.kind, reasonCode: `plan.${item.action}`, ...(item.skillRefId ? { skillRefId: item.skillRefId } : {}), ...(item.desired?.version ? { desiredVersion: item.desired.version } : {}), ...(item.desired?.digest ? { desiredDigest: item.desired.digest } : {}), ...(item.observed?.version ? { observedVersion: item.observed.version } : {}), ...(item.observed?.digest ? { observedDigest: item.observed.digest } : {}) } }));
    const planDigest = architectureSyncPlanDigest(placeholderSteps);
    const steps = placeholderSteps.map(step => ({ ...step, idempotencyKey: architectureSyncStepIdempotencyKey({ identity, planDigest, step }) }));
    await this.dependencies.assertArtifactCredential?.(actor, false, "review");
    const timestamp = this.dependencies.authorityNow ? (await this.dependencies.authorityNow()).toISOString() : this.now().toISOString();
    const runBase: ArchitectureSyncRun = { schemaVersion: 1, identity, state: "drafted", digests: { desiredDigest: snapshot.compiled.revisionDigest, compiledDigest: createHash("sha256").update(canonicalizeJson(snapshot.compiled)).digest("hex"), observedDigest: snapshot.observation.observedDigest, planDigest }, steps, receipts: [], capabilities: { "inventory.read": target.capabilities["inventory.read"] === true, "health.read": target.capabilities["health.read"] === true, "plan.read": true, apply: false, rollback: false, "sync.write": false }, createdAt: timestamp, updatedAt: timestamp, metadata: snapshot.metadata };
    const run = assertValidArchitectureSyncRun({ ...runBase, metadata: { ...snapshot.metadata, reviewDigest: reviewDigest(runBase) } });
    const result = await this.store.createRun({ actorId: actor.id, requestKey: `architecture-plan-${requestId}`, idempotencyKey: `architecture-plan-${requestId}`, intentDigest: architectureSyncOrderedDigest({ identity, digests: run.digests, steps, capabilities: run.capabilities, metadata: run.metadata }), run });
    return { run: result.run, replayed: result.decision === "duplicate" };
  }

  async listPlans(actor: ArchitecturePlanActor, targetId: string, limit = 100) {
    const target=await this.requireTarget(actor, targetId, false);
    validatePlanHistoryLimit(limit);
    const runs:ArchitectureSyncRun[]=[];
    for(const run of await this.store.listRuns({ targetId, limit, source: "architecture-plan" })) {try{await this.authorizeHistory(actor,target,run);runs.push(run);}catch(error){if(!(error instanceof AppError)||!["ARCHITECTURE_PLAN_NOT_FOUND","ARCHITECTURE_SKILL_RELEASE_UNAVAILABLE","ARCHITECTURE_REVISION_NOT_FOUND"].includes(error.code))throw error;}}
    return { runs };
  }

  async getPlan(actor: ArchitecturePlanActor, runId: string) {
    const run = await this.requireRun(runId);
    const target=await this.requireTarget(actor, run.identity.targetId, false);
    await this.authorizeHistory(actor,target,run);
    return { run };
  }

  async approvePlan(actor: ArchitecturePlanActor, runId: string, input: { expectedReviewDigest: string }) {
    validateApproveArchitecturePlanInput(input);
    const run = await this.requireRun(runId);
    if (this.store.withPlanAuthority) return this.store.withPlanAuthority({ actorId: actor.id, targetId: run.identity.targetId }, (store, dependencies) => new ArchitecturePlanService(store, dependencies, { now: this.now }).approveWithinAuthority(actor, runId, input));
    return this.approveWithinAuthority(actor, runId, input);
  }

  private async approveWithinAuthority(actor: ArchitecturePlanActor, runId: string, input: { expectedReviewDigest: string }) {
    let run = await this.requireRun(runId);
    const target = await this.requireTarget(actor, run.identity.targetId, true);
    requireMfa(actor);
    if (input.expectedReviewDigest !== run.metadata?.reviewDigest || reviewDigest(run) !== run.metadata.reviewDigest) {
      throw new AppError("The complete review digest does not match the selected plan.", "ARCHITECTURE_PLAN_REVIEW_DIGEST_CONFLICT", 409);
    }
    assertGeneration(target, run.identity.targetGeneration);
    assertCapabilities(target, run.metadata);
    const snapshot = await this.snapshot(actor, target, run.identity.revisionId);
    for (const [field, name] of [["observationId", "OBSERVATION"], ["observationDigest", "OBSERVATION"], ["revisionDigest", "REVISION"], ["targetIdentityDigest", "TARGET_IDENTITY"], ["adapterDigest", "ADAPTER"], ["capabilitiesDigest", "CAPABILITIES"], ["consentDigest", "CONSENT"], ["policyDigest", "POLICY"]] as const) {
      if (snapshot.metadata[field] !== run.metadata[field]) throw stale(name, "A reviewed plan fence has changed.");
    }
    await this.dependencies.assertArtifactCredential?.(actor, false, "review");
    if (run.approval) return approvedReplay(run, actor);
    if (run.state !== "drafted" && run.state !== "awaiting_approval") {
      throw new AppError("The plan is not awaiting review approval.", "ARCHITECTURE_PLAN_APPROVAL_STATE_INVALID", 409);
    }
    try {
      if (run.state === "drafted") run = await this.store.saveRun({ ...run, state: "awaiting_approval", updatedAt: await this.timestampAfter(run) });
      const approvedAt = await this.timestampAfter(run);
      const approval = { schemaVersion: 1 as const, id: `review-${digestIdentifier({ runId, actorId: actor.id })}`, runId, actorId: actor.id, planDigest: run.digests.planDigest, approvedAt, metadata: { reviewOnly: true, reviewDigest: input.expectedReviewDigest } };
      const next: ArchitectureSyncRun = { ...run, state: "approved", approval, digests: { ...run.digests, approvalDigest: architectureSyncSnapshotDigest(approval) }, receipts: [...run.receipts, { schemaVersion: 1, id: `review-receipt-${digestIdentifier({ runId, actorId: actor.id })}`, runId, kind: "approval", status: "succeeded", code: "plan.review.approved", recordedAt: approvedAt, evidenceDigest: input.expectedReviewDigest, metadata: { reviewOnly: true } }], updatedAt: approvedAt };
      return { run: await this.store.saveRun(next), replayed: false };
    } catch (error) {
      // The store serializes updates and rejects an overwritten approval or
      // receipt prefix. A concurrent delivery reads the committed winner.
      if (error instanceof AppError && ["ARCHITECTURE_SYNC_APPROVAL_IMMUTABLE", "ARCHITECTURE_SYNC_DIGEST_CONFLICT", "ARCHITECTURE_SYNC_RECEIPT_IMMUTABLE", "ARCHITECTURE_SYNC_TIMESTAMP_INVALID"].includes(error.code)) {
        const winner = await this.requireRun(runId);
        if (winner.approval) return approvedReplay(winner, actor);
      }
      throw error;
    }
  }

  private async authorizeHistory(actor:ArchitecturePlanActor,target:ArchitectureTargetRecord,run:ArchitectureSyncRun):Promise<void> {
    if(target.owner.type!=="organization")return;
    const revision=await this.dependencies.architectureStore.getRevisionForPreview(actor.id,target.architectureId,run.identity.revisionId,target.owner.id);
    if(!revision||revision.spec.skills.some(ref=>!["public","authenticated","organization"].includes(ref.packageVisibility)))throw new AppError("Architecture plan was not found.","ARCHITECTURE_PLAN_NOT_FOUND",404);
    for(const reference of revision.spec.skills){const visible=await this.dependencies.releaseDependencies.skillRepository.getSkillVisibleToOrganizationBySlug(reference.slug,target.owner.id);if(!visible||visible.visibility!==reference.packageVisibility)throw new AppError("Architecture plan was not found.","ARCHITECTURE_PLAN_NOT_FOUND",404);}
    await resolveAuthorizedArchitectureRegistry(this.dependencies.releaseDependencies,actor.id,revision.spec,{organizationIds:[target.owner.id]});
  }

  private async requireTarget(actor: ArchitecturePlanActor, targetId: string, control: boolean): Promise<ArchitectureTargetRecord> {
    identifier(targetId);
    identifier(actor.id);
    const target = await this.dependencies.targetStore.getTarget(actor.id, targetId);
    if (!target) throw targetNotFound();
    const architecture = await this.dependencies.architectureStore.getArchitecture(actor.id, target.architectureId);
    if (!architecture || !architecture.access.canRead || (target.owner.type === "organization" && !architecture.access.allowedOrganizationIds.includes(target.owner.id))) throw targetNotFound();
    if (control) {
      if (target.status === "revoked" || target.consent.status === "revoked") throw new AppError("The architecture target is revoked.", "ARCHITECTURE_TARGET_REVOKED", 410);
      const access = await this.dependencies.targetStore.getTargetAccess(actor.id, targetId, "revoke");
      if (!access?.allowed) throw new AppError("Managing this target is required to review a plan.", "ARCHITECTURE_PLAN_CONTROL_REQUIRED", 403);
      if (target.consent.status !== "granted") throw new AppError("Current target consent is required.", "ARCHITECTURE_PLAN_CONSENT_REQUIRED", 409);
      if (target.capabilities["plan.read"] !== true) throw new AppError("The target does not support plan inspection.", "ARCHITECTURE_PLAN_CAPABILITY_REQUIRED", 409);
    }
    return target;
  }

  private async requireRun(runId: string) {
    identifier(runId);
    const run = await this.store.getRun(runId);
    if (!run || run.metadata?.source !== "architecture-plan" || run.metadata.reviewOnly !== true || run.metadata.canApply !== false) {
      throw new AppError("Architecture plan was not found.", "ARCHITECTURE_PLAN_NOT_FOUND", 404);
    }
    return run;
  }

  async artifactSnapshot(actor: ArchitecturePlanActor, targetId: string, revisionId: string) {
    requireMfa(actor);
    const target = await this.requireTarget(actor, targetId, true);
    return { target, ...await this.snapshot(actor, target, revisionId) };
  }

  private async snapshot(actor: ArchitecturePlanActor, target: ArchitectureTargetRecord, revisionId: string) {
    const architecture = await this.dependencies.architectureStore.getArchitecture(actor.id, target.architectureId);
    if (!architecture || !architecture.access.canPreview) throw targetNotFound();
    // Organization targets carry an authoritative binding, so the selected
    // organization context is taken from that target rather than a client label.
    const organizationId = target.owner.type === "organization" ? target.owner.id : undefined;
    const revision = await this.dependencies.architectureStore.getRevisionForPreview(actor.id, target.architectureId, revisionId, organizationId);
    if (organizationId && revision?.spec.skills.some(skill => !["public", "authenticated", "organization"].includes(skill.packageVisibility))) throw targetNotFound();
    if (!revision) throw new AppError("Architecture revision was not found.", "ARCHITECTURE_REVISION_NOT_FOUND", 404);
    const current = await this.dependencies.architectureStore.getRevisionForPreview(actor.id, target.architectureId, undefined, organizationId);
    if (!current) throw new AppError("The current architecture policy is unavailable.", "ARCHITECTURE_PLAN_POLICY_STALE", 409);
    const currentEnvironment = current.spec.environments.find(environment => environment.id === target.environmentId);
    const currentProfile = current.spec.profiles.find(profile => profile.id === target.profileId);
    if (!currentProfile || !currentEnvironment || currentEnvironment.profileId !== target.profileId) throw stale("POLICY", "The target profile binding is no longer current.");
    await this.dependencies.authorizeRevision?.({ actorId: actor.id, target, architecture, revision });
    if (organizationId) {
      for (const reference of revision.spec.skills) {
        const visible = await this.dependencies.releaseDependencies.skillRepository.getSkillVisibleToOrganizationBySlug(reference.slug, organizationId);
        if (!visible || visible.visibility !== reference.packageVisibility) throw new AppError("The receiving organization cannot read an exact release.", "ARCHITECTURE_SKILL_RELEASE_UNAVAILABLE", 422);
      }
    }
    const registry = await resolveAuthorizedArchitectureRegistry(this.dependencies.releaseDependencies, actor.id, revision.spec, { ...(architecture.owner.type === "team" ? { teamId: architecture.owner.id } : {}), organizationIds: organizationId ? [organizationId] : architecture.access.allowedOrganizationIds });
    const compiled = compileArchitecture(revision.spec, { registry, profileId: target.profileId, environmentId: target.environmentId });
    const currentCompiled = compileArchitecture(current.spec, { registry: current.spec.skills, profileId: target.profileId, environmentId: target.environmentId });
    const currentNodes = new Map(currentCompiled.nodes.map(node => [node.id, node]));
    if (compiled.nodes.some(node => !currentNodes.has(node.id))) {
      throw stale("POLICY", "Historical exposure conflicts with the current target profile policy.");
    }
    const observation = (await this.dependencies.targetStore.listObservations({ actor: actor.id, targetId: target.id, limit: 1 }))?.[0];
    if (!observation?.id) throw new AppError("A trusted target observation is required.", "ARCHITECTURE_PLAN_OBSERVATION_REQUIRED", 409);
    const validated = validateArchitectureTargetObservation(observation);
    if (!validated.valid) throw stale("OBSERVATION", "The current observation digest is invalid.");
    assertGeneration(target, observation.targetGeneration);
    const adapterDigest = architectureTargetAdapterDigest(target.adapter);
    const capabilitiesDigest = architectureTargetCapabilitiesDigest(target.capabilities, target.adapter.contractVersion);
    if (observation.adapterDigest !== adapterDigest) throw stale("ADAPTER", "The observation uses a different adapter.");
    if (observation.capabilitiesDigest !== capabilitiesDigest) throw stale("CAPABILITIES", "The observation uses different target capabilities.");
    // Generic nodes preserve missing evidence as unsupported rather than
    // manufacturing defaults for version, enabled state or runtime exposure.
    const plan = planArchitectureSync(compiled, { targetId: target.id, nodes: observation.skills.map(skill => ({ ...skill })) });
    const metadata: ArchitectureSyncMetadata = { source: "architecture-plan", reviewOnly: true, dryRun: true, canApply: false, observationId: observation.id, observationDigest: observation.observedDigest, revisionDigest: compiled.revisionDigest, targetIdentityDigest: target.identityDigest, adapterDigest, capabilitiesDigest, consentDigest: architectureSyncSnapshotDigest(target.consent), policyDigest: architectureSyncSnapshotDigest({ upgradeConstraints: await this.dependencies.readPolicyConstraints?.(target) ?? null, owner: architecture.owner, access: organizationId ? { receivingOrganizationId: organizationId, canRead: architecture.access.canRead, canPreview: architecture.access.canPreview } : architecture.access, currentRevisionDigest: currentCompiled.revisionDigest, profiles: current.spec.profiles, environments: current.spec.environments }) };
    return { revision, compiled, observation, plan, metadata: sanitizeArchitectureSyncMetadata(metadata)! };
  }

  private async timestampAfter(run: ArchitectureSyncRun) { const now=this.dependencies.authorityNow ? await this.dependencies.authorityNow() : this.now(); return new Date(Math.max(now.getTime(), Date.parse(run.updatedAt))).toISOString(); }
}

function reviewDigest(run: ArchitectureSyncRun): string {
  const metadata = { ...run.metadata };
  delete metadata.reviewDigest;
  return architectureSyncOrderedDigest({ identity: run.identity, digests: { desiredDigest: run.digests.desiredDigest, compiledDigest: run.digests.compiledDigest, observedDigest: run.digests.observedDigest, planDigest: run.digests.planDigest }, steps: run.steps.map(({ state: _state, ...step }) => step), capabilities: run.capabilities, metadata });
}
function approvedReplay(run: ArchitectureSyncRun, actor: ArchitecturePlanActor) {
  if (run.approval?.actorId !== actor.id) throw new AppError("This plan was approved by a different actor.", "ARCHITECTURE_PLAN_APPROVAL_ACTOR_CONFLICT", 409);
  return { run, replayed: true };
}
function assertGeneration(target: ArchitectureTargetRecord, expected: number) { if (target.generation !== expected) throw stale("GENERATION", "The target generation has changed."); }
function assertCapabilities(target: ArchitectureTargetRecord, metadata: ArchitectureSyncMetadata) {
  if (architectureTargetAdapterDigest(target.adapter) !== metadata.adapterDigest) throw stale("ADAPTER", "The target adapter has changed.");
  if (architectureTargetCapabilitiesDigest(target.capabilities, target.adapter.contractVersion) !== metadata.capabilitiesDigest) throw stale("CAPABILITIES", "The target capabilities have changed.");
}
function targetNotFound() { return new AppError("Architecture target was not found.", "ARCHITECTURE_TARGET_NOT_FOUND", 404); }
function stale(fence: string, message: string) { return new AppError(message, `ARCHITECTURE_PLAN_${fence}_STALE`, 409); }
function requireMfa(actor: ArchitecturePlanActor) { if (!actor.mfaVerified) throw new AppError("MFA verification is required.", "MFA_VERIFICATION_REQUIRED", 403); }
function digestIdentifier(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function invalid() { return new AppError("Architecture plan request is invalid.", "INVALID_REQUEST_BODY", 400); }
function identifier(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw invalid(); }
function digest(value: unknown) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw invalid(); }
export function validateCreateArchitecturePlanInput(input: unknown): asserts input is CreateArchitecturePlanInput {
  strictRecord(input, ["revisionId", "expectedTargetGeneration", "expectedObservationId", "expectedObservationDigest", "idempotencyKey"]);
  identifier(input.revisionId); identifier(input.expectedObservationId); identifier(input.idempotencyKey); digest(input.expectedObservationDigest);
  if (!Number.isInteger(input.expectedTargetGeneration) || (input.expectedTargetGeneration as number) < 1 || (input.expectedTargetGeneration as number) > 1_000_000_000) throw invalid();
}
export function validateApproveArchitecturePlanInput(input: unknown): asserts input is { expectedReviewDigest: string } { strictRecord(input, ["expectedReviewDigest"]); digest(input.expectedReviewDigest); }
function strictRecord(input: unknown, keys: string[]): asserts input is Record<string, unknown> { if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key))) throw invalid(); }
export function validatePlanHistoryLimit(limit: number) { if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw invalid(); }
export function validateArchitecturePlanIdentifier(value: unknown): asserts value is string { identifier(value); }
