import { randomUUID } from "node:crypto";
import {
  AppError,
  architectureTargetAdapterDigest,
  architectureTargetCapabilitiesDigest,
  canonicalizeJson,
  sha256Hex,
  validateArchitectureTarget,
  validateArchitectureTargetHealth,
  validateArchitectureTargetObservation,
  type ArchitectureTarget,
  type ArchitectureTargetAccessAction,
  type ArchitectureTargetObservation,
  type ArchitectureTargetOwnerReference,
} from "@myskills-app/core";
import type {
  ArchitectureTargetActor,
  ArchitectureTargetActorInput,
  ArchitectureTargetAuditInput,
  ArchitectureTargetBinding,
  ArchitectureTargetBindingAuthorization,
  ArchitectureTargetBindingAuthorizationContext,
  ArchitectureTargetBindingAuthorizer,
  ArchitectureTargetBindingRequest,
  ArchitectureTargetRecord,
  ArchitectureTargetServiceOptions,
  ArchitectureTargetStore,
  AppendArchitectureTargetObservationInput,
  RegisterArchitectureTargetInput,
  RevokeArchitectureTargetInput,
  SetArchitectureTargetConsentInput,
  UpdateArchitectureTargetHealthInput,
} from "./types.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CREDENTIAL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * Application orchestration for connected architecture targets.
 *
 * This layer owns lifecycle and input sequencing. The store remains the
 * policy boundary for every persisted operation, resolving current team and
 * organization membership snapshots on each call. The service never accepts
 * a client-supplied membership snapshot as authority.
 */
export class ArchitectureTargetService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly store: ArchitectureTargetStore,
    private readonly bindingAuthorizer: ArchitectureTargetBindingAuthorizer,
    options: ArchitectureTargetServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async registerTarget(input: RegisterArchitectureTargetInput): Promise<ArchitectureTargetRecord> {
    const actor = normalizeActor(input.actor);
    let targetId: string | undefined;
    try {
      const name = normalizeName(input.name);
      const requestedOwner = normalizeOwner(input.owner ?? { type: "user", id: actor.userId });
      const requestedBinding = normalizeRequestedBinding(input, requestedOwner, actor);
      const authorization = await this.authorizeBinding({ actor, requestedBinding });
      const target = this.createTarget({ input, binding: authorization.binding, name });
      targetId = target.id;
      const credentialReference = normalizeCredentialReference(input.credentialReference);
      const record = await this.store.registerTarget({
        target,
        credentialReference,
        ...(authorization.authorization ? { authorization: authorization.authorization } : {}),
        audit: {
          actorUserId: actor.userId,
          action: "architecture-target.register",
          decision: "allow",
          targetId: target.id,
          details: {
            generation: target.generation,
            ownerType: target.owner.type,
            adapterDigest: architectureTargetAdapterDigest(target.adapter),
            capabilitiesDigest: architectureTargetCapabilitiesDigest(target.capabilities),
          },
        },
      });
      return record;
    } catch (error) {
      const normalized = toTargetError(error, "Architecture target could not be registered.", "ARCHITECTURE_TARGET_REGISTER_FAILED", 409);
      await this.recordAuditSafe({
        actorUserId: actor.userId,
        action: "architecture-target.register",
        decision: "deny",
        targetId,
        details: { reason: errorCode(normalized) },
      });
      throw normalized;
    }
  }

  async listTargets(actorInput: ArchitectureTargetActorInput): Promise<ArchitectureTargetRecord[]> {
    const actor = normalizeActor(actorInput);
    try {
      const records = await this.store.listTargets(actor.userId);
      await this.recordAudit({
        actorUserId: actor.userId,
        action: "architecture-target.list",
        decision: "allow",
        details: { targetCount: records.length },
      });
      return records;
    } catch (error) {
      const normalized = toTargetError(error, "Architecture targets could not be listed.", "ARCHITECTURE_TARGET_LIST_FAILED", 409);
      await this.recordAuditSafe({
        actorUserId: actor.userId,
        action: "architecture-target.list",
        decision: "deny",
        details: { reason: errorCode(normalized) },
      });
      throw normalized;
    }
  }

  async getTarget(actorInput: ArchitectureTargetActorInput, targetId: string): Promise<ArchitectureTargetRecord | null> {
    const actor = normalizeActor(actorInput);
    const id = normalizeIdentifier(targetId, "targetId");
    try {
      const record = await this.store.getTarget(actor.userId, id);
      await this.recordAudit({
        actorUserId: actor.userId,
        action: "architecture-target.read",
        decision: record ? "allow" : "deny",
        targetId: id,
        details: record ? { generation: record.generation, status: record.status } : { reason: "not_visible" },
      });
      return record;
    } catch (error) {
      const normalized = toTargetError(error, "Architecture target could not be read.", "ARCHITECTURE_TARGET_READ_FAILED", 409);
      await this.recordAuditSafe({
        actorUserId: actor.userId,
        action: "architecture-target.read",
        decision: "deny",
        targetId: id,
        details: { reason: errorCode(normalized) },
      });
      throw normalized;
    }
  }

  async grantConsent(actor: ArchitectureTargetActorInput, targetId: string): Promise<ArchitectureTargetRecord> {
    return this.setConsent({ actor, targetId, decision: "grant" });
  }

  async denyConsent(actor: ArchitectureTargetActorInput, targetId: string): Promise<ArchitectureTargetRecord> {
    return this.setConsent({ actor, targetId, decision: "deny" });
  }

  async setConsent(input: SetArchitectureTargetConsentInput): Promise<ArchitectureTargetRecord> {
    const actor = normalizeActor(input.actor);
    const targetId = normalizeIdentifier(input.targetId, "targetId");
    if (input.decision !== "grant" && input.decision !== "deny") {
      throw new AppError("Target consent decision must be grant or deny.", "INVALID_TARGET_CONSENT_DECISION", 400);
    }
    try {
      const target = await this.requireAction(actor.userId, targetId, "register");
      if (target.consent.status === "revoked" || target.status === "revoked") {
        throw new AppError("A revoked target cannot change consent.", "ARCHITECTURE_TARGET_CONSENT_TERMINAL", 409);
      }
      const record = await this.store.setConsent({
        actor: actor.userId,
        targetId,
        decision: input.decision,
        audit: {
          actorUserId: actor.userId,
          action: `architecture-target.consent.${input.decision}`,
          decision: "allow",
          targetId,
          details: {
            consentStatus: input.decision === "grant" ? "granted" : "denied",
            status: input.decision === "grant" && target.health?.status === "healthy" ? "connected" : "degraded",
          },
        },
      });
      if (!record) throw targetNotFound();
      return record;
    } catch (error) {
      const normalized = toTargetError(error, "Target consent could not be updated.", "ARCHITECTURE_TARGET_CONSENT_FAILED", 409);
      await this.recordAuditSafe({
        actorUserId: actor.userId,
        action: `architecture-target.consent.${input.decision}`,
        decision: "deny",
        targetId,
        details: { reason: errorCode(normalized) },
      });
      throw normalized;
    }
  }

  async appendObservation(input: AppendArchitectureTargetObservationInput): Promise<ArchitectureTargetObservation> {
    const actor = normalizeActor(input.actor);
    const targetId = normalizeIdentifier(input.targetId, "targetId");
    try {
      const target = await this.requireAction(actor.userId, targetId, "observe");
      if (target.consent.status !== "granted") {
        throw new AppError("Target consent is required before observations can be appended.", "ARCHITECTURE_TARGET_CONSENT_REQUIRED", 409);
      }
      if (target.status === "revoked") {
        throw new AppError("A revoked target cannot receive observations.", "ARCHITECTURE_TARGET_REVOKED", 410);
      }

      const observationInput = {
        ...input.observation,
        ...(input.observation.id === undefined ? { id: this.newObservationId() } : {}),
      };
      const validation = validateArchitectureTargetObservation(observationInput);
      if (!validation.valid) {
        throw invalidValidationError(
          "Target observation is invalid.",
          "INVALID_ARCHITECTURE_TARGET_OBSERVATION",
          validation.errors,
        );
      }
      const observation = validation.value;
      if (observation.targetId !== target.id) {
        throw new AppError("Observation targetId does not match the target.", "ARCHITECTURE_TARGET_OBSERVATION_TARGET_MISMATCH", 409);
      }
      if (observation.targetGeneration !== target.generation) {
        throw new AppError(
          "Observation generation is stale for this target.",
          "ARCHITECTURE_TARGET_GENERATION_MISMATCH",
          409,
          { expectedGeneration: target.generation },
        );
      }
      const expectedAdapterDigest = architectureTargetAdapterDigest(target.adapter);
      if (observation.adapterDigest !== expectedAdapterDigest) {
        throw new AppError(
          "Observation adapter digest does not match the current target binding.",
          "ARCHITECTURE_TARGET_ADAPTER_DIGEST_MISMATCH",
          409,
          { expectedAdapterDigest },
        );
      }
      const expectedCapabilitiesDigest = architectureTargetCapabilitiesDigest(target.capabilities);
      if (observation.capabilitiesDigest !== expectedCapabilitiesDigest) {
        throw new AppError(
          "Observation capability digest does not match the current target binding.",
          "ARCHITECTURE_TARGET_CAPABILITIES_DIGEST_MISMATCH",
          409,
          { expectedCapabilitiesDigest },
        );
      }

      const appended = await this.store.appendObservation({
        actor: actor.userId,
        targetId,
        observation,
        audit: {
          actorUserId: actor.userId,
          action: "architecture-target.observation.append",
          decision: "allow",
          targetId,
          details: observationAuditDetails(observation),
        },
      });
      if (!appended) throw targetNotFound();
      return appended;
    } catch (error) {
      const normalized = toTargetError(error, "Target observation could not be appended.", "ARCHITECTURE_TARGET_OBSERVATION_FAILED", 409);
      await this.recordAuditSafe({
        actorUserId: actor.userId,
        action: "architecture-target.observation.append",
        decision: "deny",
        targetId,
        details: { reason: errorCode(normalized) },
      });
      throw normalized;
    }
  }

  async listObservations(
    actorInput: ArchitectureTargetActorInput,
    targetId: string,
    limit?: number,
  ): Promise<ArchitectureTargetObservation[]> {
    const actor = normalizeActor(actorInput);
    const id = normalizeIdentifier(targetId, "targetId");
    try {
      await this.requireAction(actor.userId, id, "read");
      const observations = await this.store.listObservations({ actor: actor.userId, targetId: id, limit });
      if (!observations) throw targetNotFound();
      await this.recordAudit({
        actorUserId: actor.userId,
        action: "architecture-target.observation.list",
        decision: "allow",
        targetId: id,
        details: { observationCount: observations.length },
      });
      return observations;
    } catch (error) {
      const normalized = toTargetError(error, "Target observations could not be listed.", "ARCHITECTURE_TARGET_OBSERVATION_LIST_FAILED", 409);
      await this.recordAuditSafe({
        actorUserId: actor.userId,
        action: "architecture-target.observation.list",
        decision: "deny",
        targetId: id,
        details: { reason: errorCode(normalized) },
      });
      throw normalized;
    }
  }

  async updateHealth(input: UpdateArchitectureTargetHealthInput): Promise<ArchitectureTargetRecord> {
    const actor = normalizeActor(input.actor);
    const targetId = normalizeIdentifier(input.targetId, "targetId");
    try {
      const target = await this.requireAction(actor.userId, targetId, "health");
      const validation = validateArchitectureTargetHealth(input.health);
      if (!validation.valid) throw invalidValidationError("Target health is invalid.", "INVALID_ARCHITECTURE_TARGET_HEALTH", validation.errors);
      if (target.status === "revoked") throw new AppError("A revoked target cannot receive health updates.", "ARCHITECTURE_TARGET_REVOKED", 410);
      const record = await this.store.updateHealth({
        actor: actor.userId,
        targetId,
        health: validation.value,
        audit: {
          actorUserId: actor.userId,
          action: "architecture-target.health.update",
          decision: "allow",
          targetId,
          details: { healthStatus: validation.value.status },
        },
      });
      if (!record) throw targetNotFound();
      return record;
    } catch (error) {
      const normalized = toTargetError(error, "Target health could not be updated.", "ARCHITECTURE_TARGET_HEALTH_FAILED", 409);
      await this.recordAuditSafe({
        actorUserId: actor.userId,
        action: "architecture-target.health.update",
        decision: "deny",
        targetId,
        details: { reason: errorCode(normalized) },
      });
      throw normalized;
    }
  }

  async revokeTarget(input: RevokeArchitectureTargetInput): Promise<ArchitectureTargetRecord> {
    const actor = normalizeActor(input.actor);
    const targetId = normalizeIdentifier(input.targetId, "targetId");
    try {
      // A second revoke is intentionally idempotent for an actor who can still
      // read the target. This preserves terminal semantics without allowing an
      // outsider to discover a revoked target.
      const readable = await this.requireAction(actor.userId, targetId, "read");
      if (readable.status === "revoked") {
        await this.recordAudit({
          actorUserId: actor.userId,
          action: "architecture-target.revoke",
          decision: "allow",
          targetId,
          details: { status: "revoked", idempotent: true },
        });
        return readable;
      }
      await this.requireAction(actor.userId, targetId, "revoke");
      const record = await this.store.revokeTarget({
        actor: actor.userId,
        targetId,
        audit: {
          actorUserId: actor.userId,
          action: "architecture-target.revoke",
          decision: "allow",
          targetId,
          details: { status: "revoked", consentStatus: "revoked" },
        },
      });
      if (!record) throw targetNotFound();
      return record;
    } catch (error) {
      const normalized = toTargetError(error, "Target could not be revoked.", "ARCHITECTURE_TARGET_REVOKE_FAILED", 409);
      await this.recordAuditSafe({
        actorUserId: actor.userId,
        action: "architecture-target.revoke",
        decision: "deny",
        targetId,
        details: { reason: errorCode(normalized) },
      });
      throw normalized;
    }
  }

  private createTarget(input: {
    input: RegisterArchitectureTargetInput;
    binding: ArchitectureTargetBinding;
    name: string;
  }): ArchitectureTarget {
    const targetId = this.idFactory();
    const now = this.now().toISOString();
    const identityDigest = input.input.identityDigest ?? sha256Hex(canonicalizeJson({
      targetId,
      nonce: this.idFactory(),
    }));
    const target: ArchitectureTarget = {
      schemaVersion: 1,
      id: targetId,
      name: input.name,
      owner: input.binding.owner,
      adapter: input.input.adapter,
      architectureId: input.binding.architectureId,
      environmentId: input.binding.environmentId,
      profileId: input.binding.profileId,
      status: "degraded",
      consent: { status: "pending", requestedAt: now },
      generation: 1,
      identityDigest,
      capabilities: input.input.capabilities,
      ...(input.input.metadata === undefined ? {} : { metadata: input.input.metadata }),
      createdAt: now,
      updatedAt: now,
    };
    const validation = validateArchitectureTarget(target);
    if (!validation.valid) throw invalidValidationError("Architecture target is invalid.", "INVALID_ARCHITECTURE_TARGET", validation.errors);
    // Keep the registration contract strict even if a future core validator
    // is relaxed: mutation capabilities are never accepted by this service.
    if (Object.entries(validation.value.capabilities).some(([key, value]) => (
      (key === "apply" || key === "rollback" || key === "sync.write") && value === true
    ))) {
      throw new AppError("Target mutation capabilities are not supported.", "ARCHITECTURE_TARGET_MUTATION_UNSUPPORTED", 400);
    }
    return validation.value;
  }

  private async authorizeBinding(input: {
    actor: ArchitectureTargetActor;
    requestedBinding: ArchitectureTargetBindingRequest;
  }): Promise<{
    binding: ArchitectureTargetBinding;
    authorization?: ArchitectureTargetBindingAuthorizationContext;
  }> {
    let decision: ArchitectureTargetBindingAuthorization;
    try {
      decision = await this.bindingAuthorizer.authorizeBinding(input.requestedBinding);
    } catch (error) {
      throw toTargetError(error, "Target binding authorization failed.", "ARCHITECTURE_TARGET_BINDING_FAILED", 503);
    }
    if (!decision.allowed || !decision.binding) {
      throw new AppError(
        "The actor cannot bind this architecture target.",
        "ARCHITECTURE_TARGET_BINDING_FORBIDDEN",
        403,
        { reason: safeReason(decision.reason) },
      );
    }
    const binding = normalizeAuthoritativeBinding(decision.binding);
    if (!binding) {
      throw new AppError("Target binding authorization returned an invalid binding.", "ARCHITECTURE_TARGET_BINDING_INVALID", 503);
    }
    return {
      binding,
      ...(decision.authorization ? { authorization: normalizeAuthorizationContext(decision.authorization, binding, input.actor.userId) } : {}),
    };
  }

  private async requireAction(
    actorInput: ArchitectureTargetActorInput,
    targetId: string,
    action: ArchitectureTargetAccessAction,
  ): Promise<ArchitectureTargetRecord> {
    const actor = normalizeActor(actorInput);
    const evaluation = await this.store.getTargetAccess(actor.userId, targetId, action);
    if (!evaluation) throw targetNotFound();
    if (!evaluation.allowed) {
      if (evaluation.reason === "not-owner" || evaluation.reason === "not-member") throw targetNotFound();
      if (evaluation.reason === "target-revoked") throw new AppError("The architecture target has been revoked.", "ARCHITECTURE_TARGET_REVOKED", 410);
      throw new AppError("The actor is not allowed to perform this target action.", "ARCHITECTURE_TARGET_ACTION_FORBIDDEN", 403, { reason: evaluation.reason });
    }
    const target = await this.store.getTarget(actor.userId, targetId);
    if (!target) throw targetNotFound();
    return target;
  }

  private async recordAudit(input: ArchitectureTargetAuditInput): Promise<void> {
    await this.store.recordAuditEvent({ ...input, details: safeAuditDetails(input.details ?? {}) });
  }

  private async recordAuditSafe(input: ArchitectureTargetAuditInput): Promise<void> {
    try {
      await this.recordAudit(input);
    } catch {
      // An audit backend failure must not replace the operation error. The
      // persistence implementation can surface its own health signal.
    }
  }

  private newObservationId(): string {
    return this.idFactory();
  }
}

function normalizeActor(input: ArchitectureTargetActorInput): ArchitectureTargetActor {
  const record = typeof input === "object" && input !== null && !Array.isArray(input) ? input : undefined;
  const userId = typeof input === "string" ? input : record?.userId ?? record?.id;
  if (typeof userId !== "string" || !IDENTIFIER_PATTERN.test(userId)) {
    throw new AppError("Target actor id is invalid.", "INVALID_TARGET_ACTOR", 400);
  }
  if (record && Object.keys(record).some((key) => key !== "id" && key !== "userId")) {
    throw new AppError("Target actor fields are invalid.", "INVALID_TARGET_ACTOR", 400);
  }
  if (record?.userId && record.id && record.userId !== record.id) {
    throw new AppError("Target actor id is ambiguous.", "INVALID_TARGET_ACTOR", 400);
  }
  return { userId };
}

function normalizeName(input: string): string {
  if (typeof input !== "string") {
    throw new AppError("Target name must be a bounded printable string.", "INVALID_TARGET_NAME", 400);
  }
  const value = input.trim().replace(/\s+/g, " ");
  if (value.length === 0 || value.length > 120 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
    throw new AppError("Target name must be a bounded printable string.", "INVALID_TARGET_NAME", 400);
  }
  return value;
}

function normalizeIdentifier(input: string, field: string): string {
  if (typeof input !== "string") throw new AppError(`${field} is invalid.`, "INVALID_TARGET_IDENTIFIER", 400);
  const value = input.trim();
  if (!IDENTIFIER_PATTERN.test(value)) throw new AppError(`${field} is invalid.`, "INVALID_TARGET_IDENTIFIER", 400);
  return value;
}

function normalizeOwner(input: ArchitectureTargetOwnerReference): ArchitectureTargetOwnerReference {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => key !== "type" && key !== "id")
    || (input.type !== "user" && input.type !== "team" && input.type !== "organization")) {
    throw new AppError("Target owner is invalid.", "INVALID_ARCHITECTURE_TARGET_OWNER", 400);
  }
  return { type: input.type, id: normalizeIdentifier(input.id, "ownerId") };
}

function normalizeRequestedBinding(
  input: RegisterArchitectureTargetInput,
  owner: ArchitectureTargetOwnerReference,
  actor: ArchitectureTargetActor,
): ArchitectureTargetBindingRequest {
  return {
    actor,
    actorUserId: actor.userId,
    requestedOwner: { ...owner },
    owner: { ...owner },
    architectureId: normalizeIdentifier(input.architectureId, "architectureId"),
    environmentId: normalizeIdentifier(input.environmentId, "environmentId"),
    profileId: normalizeIdentifier(input.profileId, "profileId"),
  };
}

function normalizeAuthoritativeBinding(input: ArchitectureTargetBinding): ArchitectureTargetBinding | null {
  try {
    return {
      owner: normalizeOwner(input.owner),
      architectureId: normalizeIdentifier(input.architectureId, "architectureId"),
      environmentId: normalizeIdentifier(input.environmentId, "environmentId"),
      profileId: normalizeIdentifier(input.profileId, "profileId"),
    };
  } catch {
    return null;
  }
}

function normalizeAuthorizationContext(
  input: ArchitectureTargetBindingAuthorizationContext,
  binding: ArchitectureTargetBinding,
  actorUserId: string,
): ArchitectureTargetBindingAuthorizationContext {
  try {
    const normalizedActorUserId = normalizeIdentifier(input.actorUserId, "authorization.actorUserId");
    const normalizedOwner = normalizeOwner(input.owner);
    const normalizedArchitectureId = normalizeIdentifier(input.architectureId, "authorization.architectureId");
    const normalizedEnvironmentId = normalizeIdentifier(input.environmentId, "authorization.environmentId");
    const normalizedProfileId = normalizeIdentifier(input.profileId, "authorization.profileId");
    const normalizedCurrentRevisionId = input.currentRevisionId === null
      ? null
      : normalizeIdentifier(input.currentRevisionId, "authorization.currentRevisionId");
    if (normalizedActorUserId !== actorUserId
      || !sameOwner(normalizedOwner, binding.owner)
      || normalizedArchitectureId !== binding.architectureId
      || normalizedEnvironmentId !== binding.environmentId
      || normalizedProfileId !== binding.profileId) {
      throw new Error("Authorization context does not match the authoritative binding.");
    }
    return {
      actorUserId: normalizedActorUserId,
      owner: normalizedOwner,
      architectureId: normalizedArchitectureId,
      environmentId: normalizedEnvironmentId,
      profileId: normalizedProfileId,
      currentRevisionId: normalizedCurrentRevisionId,
    };
  } catch {
    throw new AppError(
      "Target binding authorization returned an invalid authorization context.",
      "ARCHITECTURE_TARGET_BINDING_INVALID",
      503,
    );
  }
}

function sameOwner(left: ArchitectureTargetOwnerReference, right: ArchitectureTargetOwnerReference): boolean {
  return left.type === right.type && left.id === right.id;
}

function normalizeCredentialReference(input: string | null | undefined): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string" || !CREDENTIAL_REFERENCE_PATTERN.test(input)) {
    throw new AppError("Credential reference is invalid.", "INVALID_TARGET_CREDENTIAL_REFERENCE", 400);
  }
  return input;
}

function invalidValidationError(
  message: string,
  code: string,
  errors: readonly { code: string }[],
): AppError {
  return new AppError(message, code, 400, {
    issueCodes: [...new Set(errors.map((error) => error.code))].sort(),
    issueCount: errors.length,
  });
}

function targetNotFound(): AppError {
  return new AppError("Architecture target not found.", "ARCHITECTURE_TARGET_NOT_FOUND", 404);
}

function toTargetError(error: unknown, message: string, code: string, statusCode: number): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error && error.name === "ArchitectureTargetValidationError") {
    const validation = error as Error & { errors?: readonly { code: string }[] };
    return invalidValidationError(message, code, validation.errors ?? []);
  }
  return new AppError(message, code, statusCode);
}

function errorCode(error: AppError): string {
  return error.code;
}

function safeReason(reason: string | undefined): string {
  if (!reason) return "binding_denied";
  return /^[A-Za-z0-9._:-]{1,64}$/.test(reason) ? reason : "binding_denied";
}

function observationAuditDetails(observation: ArchitectureTargetObservation): Record<string, unknown> {
  return {
    generation: observation.targetGeneration,
    adapterDigest: observation.adapterDigest,
    capabilitiesDigest: observation.capabilitiesDigest,
    observedDigest: observation.observedDigest,
    skillCount: observation.skills.length,
    configFindingCount: observation.configFindings.length,
  };
}

/** Whitelist audit fields so future callers cannot accidentally persist input. */
function safeAuditDetails(input: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set([
    "reason",
    "generation",
    "targetCount",
    "observationCount",
    "skillCount",
    "configFindingCount",
    "ownerType",
    "status",
    "consentStatus",
    "healthStatus",
    "adapterDigest",
    "capabilitiesDigest",
    "observedDigest",
    "expectedGeneration",
    "expectedAdapterDigest",
    "expectedCapabilitiesDigest",
    "idempotent",
  ]);
  return Object.fromEntries(Object.entries(input).filter(([key]) => allowed.has(key)));
}
