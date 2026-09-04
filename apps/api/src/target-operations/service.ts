import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AppError,
  compareSemanticVersions,
  evaluateSkillUpdate,
  skillReleaseUpdateBlockers,
  isPrereleaseVersion,
  isWithinSkillUpgradeMaintenanceWindow,
  parseSemanticVersion,
  targetSkillOperationActions,
  targetSkillOperationPlanDigest,
  targetSkillOperationResultMatchesPlan,
  type TargetSkillOperation,
  type TargetSkillOperationResult,
} from "@myskills-app/core";
import type { SubmissionService } from "../submissions/service.js";
import type { SubmissionActor } from "../submissions/types.js";
import type { ArchitectureTargetService } from "../targets/service.js";
import type { SkillUpgradePolicyService } from "../upgrade-policies/service.js";
import type { ScheduleTargetSkillOperationInput, StoredTargetSkillOperation, TargetSkillOperationStore } from "./types.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const CODE_PATTERN = /^[a-z][a-z0-9._:-]{0,95}$/;

export class TargetSkillOperationService {
  constructor(
    private readonly store: TargetSkillOperationStore,
    private readonly targets: ArchitectureTargetService,
    private readonly submissions: SubmissionService,
    private readonly options: { now?: () => Date; idFactory?: () => string; upgradePolicies?: SkillUpgradePolicyService } = {},
  ) {}

  async schedule(input: ScheduleTargetSkillOperationInput): Promise<{ operation: TargetSkillOperation; replayed: boolean }> {
    return this.store.create({ operation: await this.prepare(input) });
  }

  private async prepare(input: ScheduleTargetSkillOperationInput): Promise<StoredTargetSkillOperation> {
    const actorId = identifier(input.actorId, "actorId");
    const targetId = identifier(input.targetId, "targetId");
    if (!targetSkillOperationActions.includes(input.action)) throw invalid("Target operation action is invalid.");
    const slug = skillSlug(input.slug);
    const version = semanticVersion(input.version, "version");
    const idempotencyKey = identifier(input.idempotencyKey, "idempotencyKey");
    const readable = await this.targets.getTarget(actorId, targetId);
    if (!readable) throw notFound();
    const existing = await this.store.findByIdempotencyKey(targetId, idempotencyKey);
    if (existing) {
      if (existing.actorUserId !== actorId || existing.action !== input.action || existing.skillSlug !== slug
        || existing.toVersion !== version || (input.platform !== undefined && existing.platform !== input.platform)) {
        throw new AppError("The target operation idempotency key is already bound to another request.", "TARGET_OPERATION_IDEMPOTENCY_CONFLICT", 409);
      }
      if (!await this.canReadRelease(actorId, existing)) throw notFound();
      return existing;
    }
    const target = await this.targets.authorizeCompanionOperation(actorId, targetId, input.action);
    const observations = await this.targets.listObservations(actorId, targetId, 1);
    const observed = observations.find((item) => item.targetGeneration === undefined || item.targetGeneration === target.generation)?.skills.find((skill) => skill.slug === slug && skill.managed !== false);
    const receipt = await this.store.latestSuccess(targetId, target.generation, slug);
    const receiptVersion = receipt && (!observations[0] || receipt.updatedAt > observations[0].observedAt) ? receipt.result?.installedVersion : undefined;
    const fromVersion = receiptVersion && parseSemanticVersion(receiptVersion)
      ? receiptVersion
      : observed?.version && parseSemanticVersion(observed.version) ? observed.version : undefined;
    enforceActionVersions(input.action, fromVersion, version);

    const release = await this.submissions.getPublicRelease({ slug, version, actorId });
    if (!release || !await this.canReadRelease(actorId, { targetId, skillSlug: slug, toVersion: version })) throw new AppError("The requested release is unavailable for this target.", "TARGET_OPERATION_RELEASE_NOT_FOUND", 404);
    const platform = input.platform
      ? release.platforms.find((item) => item.name === input.platform && item.status === "supported")
      : release.platforms.find((item) => item.name === "codex" && item.status === "supported")
        ?? release.platforms.find((item) => item.status === "supported");
    if (!platform) throw new AppError("The requested release has no supported target platform.", "TARGET_OPERATION_PLATFORM_UNSUPPORTED", 409);
    const resolvedPolicy = await this.options.upgradePolicies?.resolveForTarget(target);
    if (resolvedPolicy) {
      const pin = resolvedPolicy.policy.pins[slug];
      if (pin && version !== pin) throw new AppError("The requested version conflicts with the active upgrade pin.", "TARGET_OPERATION_POLICY_PIN_CONFLICT", 409);
      if (!resolvedPolicy.policy.includePrerelease && isPrereleaseVersion(version)) throw new AppError("Prerelease upgrades are disabled by policy.", "TARGET_OPERATION_POLICY_PRERELEASE_BLOCKED", 409);
      if (!resolvedPolicy.policy.allowedChangeKinds.includes(release.changeKind)) throw new AppError("This release change kind is blocked by policy.", "TARGET_OPERATION_POLICY_CHANGE_KIND_BLOCKED", 409);
    }
    const blockers = skillReleaseUpdateBlockers(release, {
      installed: { version: fromVersion ?? "0.0.0", platform: platform.name },
      releases: [release],
      policy: { includePrerelease: true },
      client: {
        adapterContractVersion: target.adapter.contractVersion,
        ...(typeof target.metadata?.myskillsVersion === "string" ? { myskillsVersion: target.metadata.myskillsVersion } : {}),
      },
    });
    if (blockers.some((code) => input.action !== "rollback" || code !== "release-deprecated")) {
      throw new AppError("The target does not meet this release's compatibility requirements.", "TARGET_OPERATION_RELEASE_INCOMPATIBLE", 409, { blockers });
    }
    const plan = {
      targetId,
      targetGeneration: target.generation,
      action: input.action,
      skillSlug: slug,
      ...(fromVersion ? { fromVersion } : {}),
      toVersion: version,
      platform: platform.name,
      artifact: release.artifact,
    };
    const now = this.now();
    const operation: StoredTargetSkillOperation = {
      schemaVersion: 1,
      id: identifier(this.options.idFactory?.() ?? randomUUID(), "operationId"),
      ...plan,
      planDigest: targetSkillOperationPlanDigest(plan),
      state: "queued",
      fencingToken: 0,
      createdAt: now,
      updatedAt: now,
      actorUserId: actorId,
      idempotencyKey,
    };
    return operation;
  }

  async list(actorIdInput: string, targetIdInput: string): Promise<TargetSkillOperation[]> {
    const actorId = identifier(actorIdInput, "actorId");
    const targetId = identifier(targetIdInput, "targetId");
    const target = await this.targets.getTarget(actorId, targetId);
    if (!target) throw notFound();
    const operations = await this.store.listForTarget(targetId);
    const visible = await Promise.all(operations.map(async (operation) => await this.canReadRelease(actorId, operation) ? operation : null));
    return visible.filter((operation): operation is TargetSkillOperation => operation !== null);
  }

  async listUpdates(actor: SubmissionActor, targetIdInput: string): Promise<{
    targetId: string;
    observedAt: string | null;
    policy: Awaited<ReturnType<SkillUpgradePolicyService["resolveForTarget"]>> | null;
    items: Array<{ slug: string; platform: string; evaluation: ReturnType<typeof evaluateSkillUpdate> }>;
  }> {
    const actorId = identifier(actor.id, "actorId");
    const targetId = identifier(targetIdInput, "targetId");
    const target = await this.targets.getTarget(actorId, targetId);
    if (!target) throw notFound();
    const observations = await this.targets.listObservations(actorId, targetId, 1);
    const observation = observations[0];
    const policy = await this.options.upgradePolicies?.resolveForTarget(target) ?? null;
    const items = [];
    for (const skill of observation?.skills ?? []) {
      if (skill.managed === false || !skill.version || !parseSemanticVersion(skill.version)) continue;
      const receipt = await this.store.latestSuccess(targetId, target.generation, skill.slug);
      const receiptVersion = receipt && receipt.updatedAt > observation.observedAt ? receipt.result?.installedVersion : undefined;
      const installedVersion = receiptVersion && parseSemanticVersion(receiptVersion) ? receiptVersion : skill.version;
      if (!await this.canReadRelease(actorId, { targetId, skillSlug: skill.slug, toVersion: installedVersion })) continue;
      const platform = target.adapter.kind.startsWith("codex") ? "codex" : target.adapter.kind;
      const releases = (await this.submissions.listSkillReleases({ slug: skill.slug, actor }))
        .filter((release) => (release.lifecycleStatus === "approved" || release.lifecycleStatus === "deprecated") && Boolean(release.publishedAt))
        .filter((release) => !policy || policy.policy.allowedChangeKinds.includes(release.changeKind))
        .map((release) => ({ ...release, lifecycleStatus: release.lifecycleStatus as "approved" | "deprecated", publishedAt: release.publishedAt! }));
      items.push({
        slug: skill.slug,
        platform,
        evaluation: evaluateSkillUpdate({
          installed: {
            version: installedVersion,
            platform,
            ...(skill.digest && /^[a-f0-9]{64}$/.test(skill.digest) ? { artifactSha256: skill.digest } : {}),
          },
          releases,
          policy: {
            includePrerelease: policy?.policy.includePrerelease ?? false,
            ...(policy?.policy.pins[skill.slug] ? { pinnedVersion: policy.policy.pins[skill.slug] } : {}),
          },
          client: {
            adapterContractVersion: target.adapter.contractVersion,
            ...(typeof target.metadata?.myskillsVersion === "string" ? { myskillsVersion: target.metadata.myskillsVersion } : {}),
          },
        }),
      });
    }
    return { targetId, observedAt: observation?.observedAt ?? null, policy, items };
  }

  async get(actorIdInput: string, operationIdInput: string): Promise<TargetSkillOperation> {
    const actorId = identifier(actorIdInput, "actorId");
    const operation = await this.requireOperation(operationIdInput);
    const target = await this.targets.getTarget(actorId, operation.targetId);
    if (!target || !await this.canReadRelease(actorId, operation)) throw notFound();
    return publicOperation(operation);
  }

  async cancel(actorIdInput: string, operationIdInput: string): Promise<TargetSkillOperation> {
    const actorId = identifier(actorIdInput, "actorId");
    const operation = await this.requireOperation(operationIdInput);
    await this.targets.authorizeCompanionOperation(actorId, operation.targetId, operation.action);
    const cancelled = await this.store.cancel(operation.id, this.now(), actorId);
    if (!cancelled) throw new AppError("Only a queued target operation can be cancelled.", "TARGET_OPERATION_CANCEL_STATE_INVALID", 409);
    return cancelled;
  }

  async claim(input: {
    actorId: string;
    targetId: string;
    targetGeneration: number;
    holderId: string;
    leaseSeconds?: number;
  }): Promise<{ operation: TargetSkillOperation; claimToken: string } | null> {
    const actorId = identifier(input.actorId, "actorId");
    const targetId = identifier(input.targetId, "targetId");
    const holderId = identifier(input.holderId, "holderId");
    if (!Number.isInteger(input.targetGeneration) || input.targetGeneration < 1) throw invalid("Target generation is invalid.");
    const leaseSeconds = boundedLease(input.leaseSeconds);
    const now = this.now();
    const claimable = await this.store.listClaimable(targetId, now, 10, actorId);
    for (const candidate of claimable) {
      const target = await this.targets.authorizeCompanionOperation(actorId, targetId, candidate.action);
      if (target.generation !== input.targetGeneration) continue;
      const release = await this.submissions.getPublicRelease({ slug: candidate.skillSlug, version: candidate.toVersion, actorId });
      if (!release || !await this.canReadRelease(actorId, candidate)) continue;
      const policy = await this.options.upgradePolicies?.resolveForTarget(target);
      if (policy && ((policy.policy.pins[candidate.skillSlug] && policy.policy.pins[candidate.skillSlug] !== candidate.toVersion)
        || (!policy.policy.includePrerelease && isPrereleaseVersion(candidate.toVersion))
        || !policy.policy.allowedChangeKinds.includes(release.changeKind))) continue;
      if (policy?.policy.mode === "maintenance-window" && !isWithinSkillUpgradeMaintenanceWindow(policy.policy, new Date(now))) continue;
      if (candidate.targetGeneration !== input.targetGeneration) continue;
      const claimToken = randomBytes(32).toString("base64url");
      const claimed = await this.store.claim({
        actorId,
        id: candidate.id,
        targetGeneration: input.targetGeneration,
        holderId,
        claimTokenHash: tokenHash(claimToken),
        leaseExpiresAt: new Date(Date.parse(now) + leaseSeconds * 1_000).toISOString(),
        now,
      });
      if (claimed) return { operation: claimed, claimToken };
    }
    return null;
  }

  async scheduleBatch(input: {
    actorId: string;
    operations: Array<Omit<ScheduleTargetSkillOperationInput, "actorId">>;
  }): Promise<Array<{ operation: TargetSkillOperation; replayed: boolean }>> {
    if (!Array.isArray(input.operations) || input.operations.length === 0 || input.operations.length > 100) throw invalid("Target operation batch must contain from 1 to 100 items.");
    const prepared = [];
    for (const operation of input.operations) prepared.push({ operation: await this.prepare({ ...operation, actorId: input.actorId }) });
    return this.store.createBatch(prepared);
  }

  async advance(input: {
    actorId: string;
    operationId: string;
    holderId: string;
    claimToken: string;
    fencingToken: number;
    state: "applying" | "verifying";
    leaseSeconds?: number;
  }): Promise<TargetSkillOperation> {
    const operation = await this.requireOperation(input.operationId);
    await this.targets.authorizeCompanionOperation(identifier(input.actorId, "actorId"), operation.targetId, operation.action);
    const now = this.now();
    const advanced = await this.store.advance({
      actorId: identifier(input.actorId, "actorId"),
      id: operation.id,
      holderId: identifier(input.holderId, "holderId"),
      claimTokenHash: tokenHash(input.claimToken),
      fencingToken: boundedFence(input.fencingToken),
      state: input.state,
      leaseExpiresAt: new Date(Date.parse(now) + boundedLease(input.leaseSeconds) * 1_000).toISOString(),
      now,
    });
    if (!advanced) throw claimConflict();
    return advanced;
  }

  async complete(input: {
    actorId: string;
    operationId: string;
    holderId: string;
    claimToken: string;
    fencingToken: number;
    result: Omit<TargetSkillOperationResult, "recordedAt">;
  }): Promise<TargetSkillOperation> {
    const operation = await this.requireOperation(input.operationId);
    await this.targets.authorizeCompanionOperation(identifier(input.actorId, "actorId"), operation.targetId, operation.action);
    const result = normalizeResult(input.result, this.now());
    if (!targetSkillOperationResultMatchesPlan(operation, result)) throw new AppError("Success requires verification of the exact planned release.", "TARGET_OPERATION_RECEIPT_MISMATCH", 409);
    const completed = await this.store.complete({
      actorId: identifier(input.actorId, "actorId"),
      id: operation.id,
      holderId: identifier(input.holderId, "holderId"),
      claimTokenHash: tokenHash(input.claimToken),
      fencingToken: boundedFence(input.fencingToken),
      result,
      now: result.recordedAt,
    });
    if (!completed) throw claimConflict();
    return completed;
  }

  private async canReadRelease(actorId: string, operation: Pick<TargetSkillOperation, "targetId" | "skillSlug" | "toVersion">): Promise<boolean> {
    if (this.store.canReadRelease) return this.store.canReadRelease(actorId, operation);
    const target = await this.targets.getTarget(actorId, operation.targetId);
    // A shared target needs an explicitly configured scope-aware authority.
    if (!target || target.owner.type !== "user") return false;
    return Boolean(await this.submissions.getPublicRelease({ slug: operation.skillSlug, version: operation.toVersion, actorId }));
  }

  private async requireOperation(idInput: string): Promise<StoredTargetSkillOperation> {
    const operation = await this.store.get(identifier(idInput, "operationId"));
    if (!operation) throw notFound();
    return operation;
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}

function enforceActionVersions(action: "install" | "update" | "rollback", fromVersion: string | undefined, toVersion: string): void {
  if (action === "install" && fromVersion) throw new AppError("The skill is already installed on the target.", "TARGET_OPERATION_ALREADY_INSTALLED", 409);
  if (action !== "install" && !fromVersion) throw new AppError("The target has no observed installed version for this skill.", "TARGET_OPERATION_SOURCE_MISSING", 409);
  if (!fromVersion) return;
  const comparison = compareSemanticVersions(toVersion, fromVersion);
  if (action === "update" && comparison <= 0) throw new AppError("An update target must be newer than the observed version.", "TARGET_OPERATION_VERSION_DIRECTION_INVALID", 409);
  if (action === "rollback" && comparison >= 0) throw new AppError("A rollback target must be older than the observed version.", "TARGET_OPERATION_VERSION_DIRECTION_INVALID", 409);
}

function normalizeResult(input: Omit<TargetSkillOperationResult, "recordedAt">, recordedAt: string): TargetSkillOperationResult {
  if (!input || (input.status !== "succeeded" && input.status !== "failed") || typeof input.code !== "string" || !CODE_PATTERN.test(input.code)) {
    throw invalid("Target operation result is invalid.");
  }
  const result: TargetSkillOperationResult = { status: input.status, code: input.code, recordedAt };
  if (input.installedVersion !== undefined) result.installedVersion = semanticVersion(input.installedVersion, "installedVersion");
  for (const field of ["artifactSha256", "contentDigest"] as const) {
    const value = input[field];
    if (value !== undefined && !/^[a-f0-9]{64}$/.test(value)) throw invalid(`Target operation ${field} is invalid.`);
    if (value !== undefined) result[field] = value;
  }
  return result;
}

function publicOperation(operation: StoredTargetSkillOperation): TargetSkillOperation {
  const { actorUserId: _actor, idempotencyKey: _key, holderId: _holder, claimTokenHash: _token, ...safe } = operation;
  return safe;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) throw invalid(`${label} is invalid.`);
  return value;
}

function skillSlug(value: unknown): string {
  if (typeof value !== "string" || !SLUG_PATTERN.test(value)) throw invalid("Skill slug is invalid.");
  return value;
}

function semanticVersion(value: unknown, label: string): string {
  if (typeof value !== "string" || !parseSemanticVersion(value)) throw invalid(`${label} is invalid.`);
  return value;
}

function boundedLease(value = 60): number {
  if (!Number.isInteger(value) || value < 15 || value > 300) throw invalid("Target operation lease must be from 15 to 300 seconds.");
  return value;
}

function boundedFence(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000_000) throw invalid("Target operation fencing token is invalid.");
  return value;
}

function tokenHash(token: string): string {
  if (typeof token !== "string" || token.length < 32 || token.length > 128) throw claimConflict();
  return createHash("sha256").update(token).digest("hex");
}

function invalid(message: string): AppError {
  return new AppError(message, "INVALID_TARGET_OPERATION", 400);
}

function notFound(): AppError {
  return new AppError("Target operation was not found.", "TARGET_OPERATION_NOT_FOUND", 404);
}

function claimConflict(): AppError {
  return new AppError("The target operation claim is stale or invalid.", "TARGET_OPERATION_CLAIM_CONFLICT", 409);
}
