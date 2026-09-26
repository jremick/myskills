import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AppError,
  compareSemanticVersions,
  evaluateSkillUpdate,
  skillReleaseUpdateBlockers,
  skillReleaseUpgradeRange,
  skillReleaseChangeKinds,
  type SkillUpgradePolicyV1,
  isPrereleaseVersion,
  skillUpgradePoliciesAllowExecution,
  parseSemanticVersion,
  targetSkillOperationActions,
  targetSkillOperationPlanDigest,
  targetSkillOperationResultMatchesPlan,
  type TargetSkillOperation,
  type TargetSkillOperationResult,
  type LibraryUpdateItemLibraryState,
} from "@myskills-app/core";
import type { LibraryAdoptionConstraintSource } from "../libraries/service.js";
import type { SubmissionService } from "../submissions/service.js";
import type { PublicReleaseMetadata, SubmissionActor } from "../submissions/types.js";
import type { ArchitectureTargetRecord } from "../targets/types.js";
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
    private readonly options: {
      now?: () => Date;
      idFactory?: () => string;
      upgradePolicies?: SkillUpgradePolicyService;
      /** Dynamic exact-version constraint from explicit library bindings. */
      libraryAdoptions?: LibraryAdoptionConstraintSource;
    } = {},
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
    // Rollback stays an explicit local recovery action; install and update follow the adoption.
    if (input.action !== "rollback") await this.assertLibraryAdoption(actorId, targetId, slug, version, fromVersion);
    const resolvedPolicy = await this.options.upgradePolicies?.resolveForTarget(target);
    if (resolvedPolicy) {
      const policies = resolvedPolicy.constraints.map(({ policy }) => policy);
      if (policies.some((policy) => Object.hasOwn(policy.pins, slug) && version !== policy.pins[slug])) throw new AppError("The requested version conflicts with the active upgrade pin.", "TARGET_OPERATION_POLICY_PIN_CONFLICT", 409);
      if (policies.some((policy) => !policy.includePrerelease) && isPrereleaseVersion(version)) throw new AppError("Prerelease upgrades are disabled by policy.", "TARGET_OPERATION_POLICY_PRERELEASE_BLOCKED", 409);
      if (!await this.changeKindsAllowed(actorId, slug, fromVersion, release, policies)) throw new AppError("The upgrade range contains a release change kind blocked by policy.", "TARGET_OPERATION_POLICY_CHANGE_KIND_BLOCKED", 409);
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
    items: Array<{ slug: string; platform: string; evaluation: ReturnType<typeof evaluateSkillUpdate>; library?: LibraryUpdateItemLibraryState }>;
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
      const newerReceipt = receiptVersion && parseSemanticVersion(receiptVersion) ? receipt?.result : undefined;
      const installedVersion = newerReceipt?.installedVersion ?? skill.version;
      const installedDigest = newerReceipt ? newerReceipt.artifactSha256 : skill.digest;
      if (!await this.canReadRelease(actorId, { targetId, skillSlug: skill.slug, toVersion: installedVersion })) continue;
      const platform = target.adapter.kind.startsWith("codex") ? "codex" : target.adapter.kind;
      const releases = (await this.submissions.listSkillReleases({ slug: skill.slug, actor }))
        .filter((release) => (release.lifecycleStatus === "approved" || release.lifecycleStatus === "deprecated") && Boolean(release.publishedAt)
          && release.reviewStatus === "approved" && release.securityStatus === "passed")
        .map((release) => ({ ...release, lifecycleStatus: release.lifecycleStatus as "approved" | "deprecated", publishedAt: release.publishedAt! }));
      const changeHistory = await this.submissions.listSkillReleaseChangeHistory({ slug: skill.slug, actorId });
      // A library binding adds exact adopted-version pins. Every existing
      // constraint still applies, so approved-but-unadopted releases are not offered.
      const library = await this.options.libraryAdoptions?.resolveTargetConstraints({ actorId, targetId, slug: skill.slug, installedVersion }) ?? null;
      const policyConstraints = [
        ...(policy?.constraints.map(({ policy: constraint }) => ({
          includePrerelease: constraint.includePrerelease,
          allowedChangeKinds: constraint.allowedChangeKinds,
          ...(Object.hasOwn(constraint.pins, skill.slug) ? { pinnedVersion: constraint.pins[skill.slug] } : {}),
        })) ?? []),
        ...(library?.pins.map((pinnedVersion) => ({ pinnedVersion })) ?? []),
      ];
      items.push({
        slug: skill.slug,
        platform,
        evaluation: evaluateSkillUpdate({
          installed: {
            version: installedVersion,
            platform,
            ...(installedDigest && /^[a-f0-9]{64}$/.test(installedDigest) ? { artifactSha256: installedDigest } : {}),
          },
          releases,
          changeHistory,
          policyConstraints: policy || library ? policyConstraints : undefined,
          client: {
            adapterContractVersion: target.adapter.contractVersion,
            ...(typeof target.metadata?.myskillsVersion === "string" ? { myskillsVersion: target.metadata.myskillsVersion } : {}),
          },
        }),
        ...(library ? { library: { state: library.state, entryIds: library.entryIds, adoptedVersions: library.adoptedVersions } } : {}),
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
      if (policy) {
        const policies = policy.constraints.map(({ policy }) => policy);
        if (policies.some((constraint) => (Object.hasOwn(constraint.pins, candidate.skillSlug) && constraint.pins[candidate.skillSlug] !== candidate.toVersion)
          || (!constraint.includePrerelease && isPrereleaseVersion(candidate.toVersion)))) continue;
        if (!await this.changeKindsAllowed(actorId, candidate.skillSlug, candidate.fromVersion, release, policies)) continue;
        if (!skillUpgradePoliciesAllowExecution(policy.constraints, new Date(now))) continue;
      }
      if (!await this.libraryAllows(actorId, candidate)) continue;
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
    const actorId = identifier(input.actorId, "actorId");
    const target = await this.targets.authorizeCompanionOperation(actorId, operation.targetId, operation.action);
    await this.assertCurrentPolicy(actorId, operation, target);
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
    const actorId = identifier(input.actorId, "actorId");
    const target = await this.targets.authorizeCompanionOperation(actorId, operation.targetId, operation.action);
    const result = normalizeResult(input.result, this.now());
    if (result.status === "succeeded") await this.assertCurrentPolicy(actorId, operation, target);
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

  private async changeKindsAllowed(actorId: string, slug: string, fromVersion: string | undefined,
    release: PublicReleaseMetadata, policies: readonly SkillUpgradePolicyV1[]): Promise<boolean> {
    const allowed = (kind: PublicReleaseMetadata["changeKind"]) => policies.every((policy) => policy.allowedChangeKinds.includes(kind));
    if (!allowed(release.changeKind)) return false;
    if (!fromVersion || compareSemanticVersions(fromVersion, release.version) >= 0
      || skillReleaseChangeKinds.every(allowed)) return true;
    const history = await this.submissions.listSkillReleaseChangeHistory({ slug, actorId });
    return skillReleaseUpgradeRange(history, fromVersion, release.version).every((item) => allowed(item.changeKind));
  }

  private async assertLibraryAdoption(actorId: string, targetId: string, slug: string, version: string, installedVersion: string | undefined): Promise<void> {
    const constraint = await this.options.libraryAdoptions?.resolveTargetConstraints({
      actorId,
      targetId,
      slug,
      ...(installedVersion ? { installedVersion } : {}),
    });
    if (!constraint) return;
    if (constraint.state === "binding-version-conflict") {
      throw new AppError("Library bindings select different versions for this skill on the target.", "BINDING_VERSION_CONFLICT", 409, { adoptedVersions: constraint.adoptedVersions });
    }
    if (constraint.pins.includes(version)) return;
    if (constraint.state === "curation-unavailable") {
      throw new AppError("The bound library entry is unavailable; the target stays on its pinned version.", "TARGET_OPERATION_LIBRARY_CURATION_UNAVAILABLE", 409);
    }
    throw new AppError("The requested version is not the library's adopted release.", "TARGET_OPERATION_LIBRARY_ADOPTION_MISMATCH", 409, { adoptedVersions: constraint.adoptedVersions });
  }

  private async libraryAllows(actorId: string, operation: Pick<TargetSkillOperation, "action" | "targetId" | "skillSlug" | "toVersion" | "fromVersion">): Promise<boolean> {
    if (operation.action === "rollback" || !this.options.libraryAdoptions) return true;
    try {
      await this.assertLibraryAdoption(actorId, operation.targetId, operation.skillSlug, operation.toVersion, operation.fromVersion);
      return true;
    } catch (error) {
      if (error instanceof AppError) return false;
      throw error;
    }
  }

  private async assertCurrentPolicy(actorId: string, operation: TargetSkillOperation, target: ArchitectureTargetRecord): Promise<void> {
    if (!await this.libraryAllows(actorId, operation)) {
      throw new AppError("The operation no longer matches the bound library adoption.", "TARGET_OPERATION_POLICY_CHANGED", 409);
    }
    const policy = await this.options.upgradePolicies?.resolveForTarget(target);
    if (!policy) return;
    const release = await this.submissions.getPublicRelease({ actorId, slug: operation.skillSlug, version: operation.toVersion });
    const policies = policy.constraints.map(({ policy }) => policy);
    if (!release || policies.some((constraint) => (Object.hasOwn(constraint.pins, operation.skillSlug) && constraint.pins[operation.skillSlug] !== operation.toVersion)
      || (!constraint.includePrerelease && isPrereleaseVersion(operation.toVersion)))
      || !await this.changeKindsAllowed(actorId, operation.skillSlug, operation.fromVersion, release, policies)) {
      throw new AppError("The operation no longer meets every applicable upgrade policy.", "TARGET_OPERATION_POLICY_CHANGED", 409);
    }
    if (!skillUpgradePoliciesAllowExecution(policy.constraints, new Date(this.now()))) {
      throw new AppError("The operation is outside an applicable maintenance window.", "TARGET_OPERATION_OUTSIDE_MAINTENANCE_WINDOW", 409);
    }
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
