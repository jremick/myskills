import { AppError, architectureTargetAdapterDigest, architectureTargetCapabilitiesDigest, evaluateArchitectureTargetAccess, validateArchitectureTarget, validateArchitectureTargetHealth, validateArchitectureTargetObservation, type ArchitectureTarget, type ArchitectureTargetAccessAction, type ArchitectureTargetHealth, type ArchitectureTargetObservation, type ArchitectureTargetOrganizationMembership, type ArchitectureTargetOwnerReference, type ArchitectureTargetTeamMembership } from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type {
  ArchitectureTargetActorInput,
  ArchitectureTargetAuditEvent,
  ArchitectureTargetAuditInput,
  ArchitectureTargetBindingAuthorization,
  ArchitectureTargetBindingAuthorizer,
  ArchitectureTargetBindingRequest,
  ArchitectureTargetMembershipResolver,
  ArchitectureTargetRecord,
  ArchitectureTargetStore,
  AppendArchitectureTargetObservationStoreInput,
  RegisterArchitectureTargetStoreInput,
  RevokeArchitectureTargetStoreInput,
  SetArchitectureTargetConsentStoreInput,
  UpdateArchitectureTargetHealthStoreInput,
} from "./types.js";

interface StoredArchitectureTarget extends ArchitectureTargetRecord {
  /** The opaque reference is retained only inside this private record. */
  credentialReference: string | null;
}

const CREDENTIAL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const ACTOR_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface MemoryArchitectureTargetTeamMembership {
  userId: string;
  teamId: string;
  role: ArchitectureTargetTeamMembership["role"];
}

export interface MemoryArchitectureTargetOrganizationMembership {
  userId: string;
  organizationId: string;
  role: ArchitectureTargetOrganizationMembership["role"];
}

export interface MemoryArchitectureTargetStoreOptions {
  /** Injectable clock keeps lifecycle and ordering tests deterministic. */
  now?: () => Date;
  /** Called before the target and required allow audit commit together. */
  beforeCommit?: (input: RegisterArchitectureTargetStoreInput) => void;
  /** Test-only failure injection before an allow audit commit. */
  beforeAuditInsert?: () => void | Promise<void>;
  /** Seeded memberships are mutable fixture state, not caller-provided facts. */
  teamMemberships?: readonly MemoryArchitectureTargetTeamMembership[];
  organizationMemberships?: readonly MemoryArchitectureTargetOrganizationMembership[];
  /** Optional canonical membership authority consulted afresh on every call. */
  membershipResolver?: ArchitectureTargetMembershipResolver;
}

/**
 * Deterministic memory persistence for the target control plane. It models
 * private credentials, immutable observations, and the current-membership
 * policy boundary without exposing private state through its public methods.
 */
export class MemoryArchitectureTargetStore implements ArchitectureTargetStore {
  readonly kind = "memory" as const;

  private readonly targets = new Map<string, StoredArchitectureTarget>();
  private readonly observations = new Map<string, ArchitectureTargetObservation[]>();
  private readonly audits: ArchitectureTargetAuditEvent[] = [];
  private readonly teamsByUser = new Map<string, Map<string, ArchitectureTargetTeamMembership["role"]>>();
  private readonly organizationsByUser = new Map<string, Map<string, ArchitectureTargetOrganizationMembership["role"]>>();
  private readonly now: () => Date;
  private readonly membershipResolver?: ArchitectureTargetMembershipResolver;
  private beforeCommit?: (input: RegisterArchitectureTargetStoreInput) => void;
  private readonly beforeAuditInsert?: () => void | Promise<void>;
  private nextAuditNumber = 1;

  constructor(options: MemoryArchitectureTargetStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.beforeCommit = options.beforeCommit;
    this.beforeAuditInsert = options.beforeAuditInsert;
    this.membershipResolver = options.membershipResolver;
    for (const membership of options.teamMemberships ?? []) this.setTeamMembership(membership.userId, membership.teamId, membership.role);
    for (const membership of options.organizationMemberships ?? []) this.setOrganizationMembership(membership.userId, membership.organizationId, membership.role);
  }

  /** Set or replace current team membership for a memory fixture actor. */
  setTeamMembership(userId: string, teamId: string, role: ArchitectureTargetTeamMembership["role"]): void {
    const memberships = this.teamsByUser.get(userId) ?? new Map<string, ArchitectureTargetTeamMembership["role"]>();
    memberships.set(teamId, role);
    this.teamsByUser.set(userId, memberships);
  }

  /** Remove current team membership; subsequent calls observe the removal. */
  removeTeamMembership(userId: string, teamId: string): void {
    const memberships = this.teamsByUser.get(userId);
    memberships?.delete(teamId);
    if (memberships && memberships.size === 0) this.teamsByUser.delete(userId);
  }

  /** Set or replace current organization membership for a memory fixture actor. */
  setOrganizationMembership(userId: string, organizationId: string, role: ArchitectureTargetOrganizationMembership["role"]): void {
    const memberships = this.organizationsByUser.get(userId) ?? new Map<string, ArchitectureTargetOrganizationMembership["role"]>();
    memberships.set(organizationId, role);
    this.organizationsByUser.set(userId, memberships);
  }

  /** Remove current organization membership; subsequent calls observe the removal. */
  removeOrganizationMembership(userId: string, organizationId: string): void {
    const memberships = this.organizationsByUser.get(userId);
    memberships?.delete(organizationId);
    if (memberships && memberships.size === 0) this.organizationsByUser.delete(userId);
  }

  async listTargets(actorInput: ArchitectureTargetActorInput): Promise<ArchitectureTargetRecord[]> {
    const actor = await this.resolveActor(actorInput);
    return [...this.targets.values()]
      .filter((target) => evaluateArchitectureTargetAccess({ owner: target.owner, status: target.status, actor, action: "list" }).allowed)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .map((target) => clonePublicTarget(target));
  }

  async getTarget(actorInput: ArchitectureTargetActorInput, targetId: string): Promise<ArchitectureTargetRecord | null> {
    const actor = await this.resolveActor(actorInput);
    const target = this.targets.get(targetId);
    if (!target) return null;
    const access = evaluateArchitectureTargetAccess({ owner: target.owner, status: target.status, actor, action: "read" });
    return access.allowed ? clonePublicTarget(target) : null;
  }

  async getTargetAccess(
    actorInput: ArchitectureTargetActorInput,
    targetId: string,
    action: ArchitectureTargetAccessAction,
  ) {
    const actor = await this.resolveActor(actorInput);
    const target = this.targets.get(targetId);
    if (!target) return null;
    return evaluateArchitectureTargetAccess({ owner: target.owner, status: target.status, actor, action });
  }

  async registerTarget(input: RegisterArchitectureTargetStoreInput): Promise<ArchitectureTargetRecord> {
    const validation = validateArchitectureTarget(input.target);
    if (!validation.valid) {
      throw new AppError("Architecture target is invalid.", "INVALID_ARCHITECTURE_TARGET", 400, {
        issueCodes: [...new Set(validation.errors.map((error) => error.code))].sort(),
      });
    }
    if (this.targets.has(validation.value.id)) {
      throw new AppError("Architecture target already exists.", "ARCHITECTURE_TARGET_ALREADY_EXISTS", 409);
    }
    if (input.credentialReference !== null
      && (typeof input.credentialReference !== "string" || !CREDENTIAL_REFERENCE_PATTERN.test(input.credentialReference))) {
      throw new AppError("Credential reference is invalid.", "INVALID_TARGET_CREDENTIAL_REFERENCE", 400);
    }
    const target: StoredArchitectureTarget = {
      ...validation.value,
      createdAt: validation.value.createdAt ?? this.timestamp(),
      updatedAt: validation.value.updatedAt ?? this.timestamp(),
      health: null,
      credentialReference: input.credentialReference,
    };
    assertRegistrationAudit(input.audit, target);
    const audit = this.createAuditEvent(input.audit);

    // The callback is intentionally before any map or journal mutation. It
    // models an audit backend failure at the atomic commit boundary and keeps
    // a retry from observing a target whose required allow audit is missing.
    this.beforeCommit?.(input);
    await this.beforeAuditInsert?.();
    this.targets.set(target.id, target);
    this.observations.set(target.id, []);
    this.audits.push(audit);
    this.nextAuditNumber += 1;
    return clonePublicTarget(target);
  }

  async setConsent(input: SetArchitectureTargetConsentStoreInput): Promise<ArchitectureTargetRecord | null> {
    assertMutationAudit(input.audit, `architecture-target.consent.${input.decision}`, input.targetId);
    const actor = await this.resolveActor(input.actor);
    const target = this.targets.get(input.targetId);
    if (!target) return null;
    const access = evaluateArchitectureTargetAccess({ owner: target.owner, status: target.status, actor, action: "register" });
    if (!access.allowed || target.status === "revoked" || target.consent.status === "revoked") return null;
    const audit = this.createAuditEvent(input.audit);
    await this.beforeAuditInsert?.();
    const now = this.timestamp();
    if (input.decision === "grant") {
      target.consent = {
        status: "granted",
        requestedAt: target.consent.requestedAt,
        grantedAt: now,
      };
      target.status = target.health?.status === "healthy" ? "connected" : "degraded";
    } else {
      target.consent = {
        status: "denied",
        requestedAt: target.consent.requestedAt,
        deniedAt: now,
      };
      target.status = "degraded";
    }
    target.updatedAt = now;
    this.audits.push(audit);
    this.nextAuditNumber += 1;
    return clonePublicTarget(target);
  }

  async appendObservation(input: AppendArchitectureTargetObservationStoreInput): Promise<ArchitectureTargetObservation | null> {
    assertMutationAudit(input.audit, "architecture-target.observation.append", input.targetId);
    const actor = await this.resolveActor(input.actor);
    const target = this.targets.get(input.targetId);
    if (!target) return null;
    const access = evaluateArchitectureTargetAccess({ owner: target.owner, status: target.status, actor, action: "observe" });
    if (!access.allowed || target.status === "revoked" || target.consent.status !== "granted") return null;

    const validation = validateArchitectureTargetObservation(input.observation);
    if (!validation.valid) {
      throw new AppError("Target observation is invalid.", "INVALID_ARCHITECTURE_TARGET_OBSERVATION", 400, {
        issueCodes: [...new Set(validation.errors.map((error) => error.code))].sort(),
      });
    }
    const observation = validation.value;
    if (observation.targetId !== target.id) {
      throw new AppError("Observation targetId does not match the target.", "ARCHITECTURE_TARGET_OBSERVATION_TARGET_MISMATCH", 409);
    }
    if (observation.targetGeneration !== target.generation) {
      throw new AppError("Observation generation is stale for this target.", "ARCHITECTURE_TARGET_GENERATION_MISMATCH", 409, {
        expectedGeneration: target.generation,
      });
    }
    const expectedAdapterDigest = architectureTargetAdapterDigest(target.adapter);
    if (observation.adapterDigest !== expectedAdapterDigest) {
      throw new AppError("Observation adapter digest does not match the current target binding.", "ARCHITECTURE_TARGET_ADAPTER_DIGEST_MISMATCH", 409);
    }
    const expectedCapabilitiesDigest = architectureTargetCapabilitiesDigest(target.capabilities);
    if (observation.capabilitiesDigest !== expectedCapabilitiesDigest) {
      throw new AppError("Observation capability digest does not match the current target binding.", "ARCHITECTURE_TARGET_CAPABILITIES_DIGEST_MISMATCH", 409);
    }
    const existing = this.observations.get(target.id) ?? [];
    if (observation.id && existing.some((candidate) => candidate.id === observation.id)) {
      throw new AppError("Target observation already exists.", "ARCHITECTURE_TARGET_OBSERVATION_ALREADY_EXISTS", 409);
    }
    const audit = this.createAuditEvent(input.audit);
    await this.beforeAuditInsert?.();
    existing.push(structuredClone(observation));
    this.observations.set(target.id, existing);
    this.audits.push(audit);
    this.nextAuditNumber += 1;
    return structuredClone(observation);
  }

  async listObservations(input: {
    actor: ArchitectureTargetActorInput;
    targetId: string;
    limit?: number;
  }): Promise<ArchitectureTargetObservation[] | null> {
    const actor = await this.resolveActor(input.actor);
    const target = this.targets.get(input.targetId);
    if (!target) return null;
    const access = evaluateArchitectureTargetAccess({ owner: target.owner, status: target.status, actor, action: "read" });
    if (!access.allowed) return null;
    const requestedLimit = input.limit ?? 100;
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), 500)
      : 100;
    return (this.observations.get(target.id) ?? [])
      .slice()
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt) || (right.id ?? "").localeCompare(left.id ?? ""))
      .slice(0, limit)
      .map((observation) => structuredClone(observation));
  }

  async updateHealth(input: UpdateArchitectureTargetHealthStoreInput): Promise<ArchitectureTargetRecord | null> {
    assertMutationAudit(input.audit, "architecture-target.health.update", input.targetId);
    const actor = await this.resolveActor(input.actor);
    const target = this.targets.get(input.targetId);
    if (!target) return null;
    const access = evaluateArchitectureTargetAccess({ owner: target.owner, status: target.status, actor, action: "health" });
    if (!access.allowed || target.status === "revoked") return null;
    const validation = validateArchitectureTargetHealth(input.health);
    if (!validation.valid) {
      throw new AppError("Target health is invalid.", "INVALID_ARCHITECTURE_TARGET_HEALTH", 400, {
        issueCodes: [...new Set(validation.errors.map((error) => error.code))].sort(),
      });
    }
    assertHealthIsCurrent(target.health, validation.value);
    const audit = this.createAuditEvent(input.audit);
    await this.beforeAuditInsert?.();
    target.health = structuredClone(validation.value);
    target.status = target.consent.status === "granted" && validation.value.status === "healthy" ? "connected" : "degraded";
    target.updatedAt = this.timestamp();
    this.audits.push(audit);
    this.nextAuditNumber += 1;
    return clonePublicTarget(target);
  }

  async revokeTarget(input: RevokeArchitectureTargetStoreInput): Promise<ArchitectureTargetRecord | null> {
    assertMutationAudit(input.audit, "architecture-target.revoke", input.targetId);
    const actor = await this.resolveActor(input.actor);
    const target = this.targets.get(input.targetId);
    if (!target) return null;
    const readAccess = evaluateArchitectureTargetAccess({ owner: target.owner, status: target.status, actor, action: "read" });
    if (target.status === "revoked") return readAccess.allowed ? clonePublicTarget(target) : null;
    const access = evaluateArchitectureTargetAccess({ owner: target.owner, status: target.status, actor, action: "revoke" });
    if (!access.allowed) return null;
    const audit = this.createAuditEvent(input.audit);
    await this.beforeAuditInsert?.();
    const now = this.timestamp();
    target.status = "revoked";
    target.consent = {
      status: "revoked",
      requestedAt: target.consent.requestedAt,
      revokedAt: now,
    };
    target.credentialReference = null;
    target.updatedAt = now;
    this.audits.push(audit);
    this.nextAuditNumber += 1;
    return clonePublicTarget(target);
  }

  async recordAuditEvent(input: ArchitectureTargetAuditInput): Promise<void> {
    this.audits.push(this.createAuditEvent(input));
    this.nextAuditNumber += 1;
  }

  /** Install a deterministic failure before the atomic registration commit. */
  setBeforeCommitFailure(callback?: (input: RegisterArchitectureTargetStoreInput) => void): void {
    this.beforeCommit = callback;
  }

  async listAuditEvents(limit = 100): Promise<ArchitectureTargetAuditEvent[]> {
    const bounded = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 100;
    return this.audits.slice(-bounded).reverse().map((event) => ({
      ...event,
      details: structuredClone(event.details),
    }));
  }

  private async resolveActor(actorInput: ArchitectureTargetActorInput) {
    const userId = actorId(actorInput);
    // A configured resolver is canonical. Seeded maps are used only for the
    // self-contained fixture mode so a removed membership cannot linger as a
    // stale fallback when the real authority says it is gone.
    const teams = this.membershipResolver
      ? new Map<string, ArchitectureTargetTeamMembership["role"]>()
      : new Map<string, ArchitectureTargetTeamMembership["role"]>(this.teamsByUser.get(userId));
    const organizations = this.membershipResolver
      ? new Map<string, ArchitectureTargetOrganizationMembership["role"]>()
      : new Map<string, ArchitectureTargetOrganizationMembership["role"]>(this.organizationsByUser.get(userId));
    if (this.membershipResolver) {
      const [currentTeams, currentOrganizations] = await Promise.all([
        this.membershipResolver.listTeamMemberships(userId),
        this.membershipResolver.listOrganizationMemberships(userId),
      ]);
      for (const membership of currentTeams) teams.set(membership.teamId, strongerTeamRole(teams.get(membership.teamId), membership.role));
      for (const membership of currentOrganizations) organizations.set(membership.organizationId, strongerOrganizationRole(organizations.get(membership.organizationId), membership.role));
    }
    return {
      userId,
      teamMemberships: [...teams.entries()]
        .map(([teamId, role]) => ({ teamId, role }))
        .sort((left, right) => left.teamId.localeCompare(right.teamId)),
      organizationMemberships: [...organizations.entries()]
        .map(([organizationId, role]) => ({ organizationId, role }))
        .sort((left, right) => left.organizationId.localeCompare(right.organizationId)),
    };
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private createAuditEvent(input: ArchitectureTargetAuditInput): ArchitectureTargetAuditEvent {
    return {
      id: `architecture-target-audit-${this.nextAuditNumber}`,
      actorUserId: input.actorUserId,
      action: input.action,
      decision: input.decision,
      targetId: input.targetId ?? null,
      details: sanitizeTargetAuditDetails(input.details ?? {}),
      createdAt: this.timestamp(),
    };
  }
}

export interface MemoryArchitectureTargetBindingOutcome {
  actorUserId: string;
  owner: ArchitectureTargetOwnerReference;
  architectureId: string;
  environmentId: string;
  profileId: string;
  authorization: ArchitectureTargetBindingAuthorization;
}

export interface MemoryArchitectureTargetBindingAuthorizerOptions {
  outcomes?: readonly MemoryArchitectureTargetBindingOutcome[];
  defaultAuthorization?: ArchitectureTargetBindingAuthorization;
}

/** Small fixture authorizer for service tests and local API composition. */
export class MemoryArchitectureTargetBindingAuthorizer implements ArchitectureTargetBindingAuthorizer {
  private readonly outcomes = new Map<string, ArchitectureTargetBindingAuthorization>();
  private readonly defaultAuthorization: ArchitectureTargetBindingAuthorization;

  constructor(options: MemoryArchitectureTargetBindingAuthorizerOptions = {}) {
    this.defaultAuthorization = options.defaultAuthorization ?? { allowed: false, reason: "no_binding_fixture" };
    for (const outcome of options.outcomes ?? []) this.setOutcome(outcome);
  }

  setOutcome(outcome: MemoryArchitectureTargetBindingOutcome): void {
    this.outcomes.set(bindingKey(outcome), cloneAuthorization(outcome.authorization));
  }

  async authorizeBinding(input: ArchitectureTargetBindingRequest): Promise<ArchitectureTargetBindingAuthorization> {
    return cloneAuthorization(this.outcomes.get(bindingKey({
      actorUserId: input.actorUserId,
      owner: input.requestedOwner,
      architectureId: input.architectureId,
      environmentId: input.environmentId,
      profileId: input.profileId,
    })) ?? this.defaultAuthorization);
  }
}

function clonePublicTarget(target: StoredArchitectureTarget): ArchitectureTargetRecord {
  const { credentialReference: _credentialReference, ...publicTarget } = target;
  return structuredClone(publicTarget);
}

function actorId(input: ArchitectureTargetActorInput): string {
  const record = typeof input === "object" && input !== null && !Array.isArray(input) ? input : undefined;
  const userId = typeof input === "string" ? input : record?.userId ?? record?.id;
  if (typeof userId !== "string" || !ACTOR_IDENTIFIER_PATTERN.test(userId)) {
    throw new AppError("Target actor id is invalid.", "INVALID_TARGET_ACTOR", 400);
  }
  if (record && Object.keys(record).some((key) => key !== "id" && key !== "userId")) {
    throw new AppError("Target actor fields are invalid.", "INVALID_TARGET_ACTOR", 400);
  }
  if (record?.userId && record.id && record.userId !== record.id) throw new AppError("Target actor id is ambiguous.", "INVALID_TARGET_ACTOR", 400);
  return userId;
}

function assertRegistrationAudit(
  input: ArchitectureTargetAuditInput | undefined,
  target: ArchitectureTarget,
): void {
  if (!input
    || input.action !== "architecture-target.register"
    || input.decision !== "allow"
    || input.targetId !== target.id
    || typeof input.actorUserId !== "string"
    || input.actorUserId.length === 0) {
    throw new AppError(
      "A valid registration allow audit is required.",
      "INVALID_ARCHITECTURE_TARGET_AUDIT",
      400,
    );
  }
}

function assertMutationAudit(
  input: ArchitectureTargetAuditInput | undefined,
  action: string,
  targetId: string,
): void {
  if (!input
    || input.action !== action
    || input.decision !== "allow"
    || input.targetId !== targetId
    || typeof input.actorUserId !== "string"
    || input.actorUserId.length === 0) {
    throw new AppError(
      "A valid target mutation allow audit is required.",
      "INVALID_ARCHITECTURE_TARGET_AUDIT",
      400,
    );
  }
}

function assertHealthIsCurrent(
  current: ArchitectureTargetHealth | null,
  next: ArchitectureTargetHealth,
): void {
  if (!current || Date.parse(next.checkedAt) >= Date.parse(current.checkedAt)) return;
  throw new AppError(
    "Target health update is older than the current health record.",
    "ARCHITECTURE_TARGET_HEALTH_STALE",
    409,
    { currentCheckedAt: current.checkedAt, requestedCheckedAt: next.checkedAt },
  );
}

function strongerTeamRole(current: ArchitectureTargetTeamMembership["role"] | undefined, next: ArchitectureTargetTeamMembership["role"]): ArchitectureTargetTeamMembership["role"] {
  return current === "owner" || next === "owner" ? "owner" : "member";
}

function strongerOrganizationRole(
  current: ArchitectureTargetOrganizationMembership["role"] | undefined,
  next: ArchitectureTargetOrganizationMembership["role"],
): ArchitectureTargetOrganizationMembership["role"] {
  if (current === "owner" || next === "owner") return "owner";
  if (current === "admin" || next === "admin") return "admin";
  return "member";
}

function bindingKey(input: {
  actorUserId: string;
  owner: ArchitectureTargetOwnerReference;
  architectureId: string;
  environmentId: string;
  profileId: string;
}): string {
  return [input.actorUserId, input.owner.type, input.owner.id, input.architectureId, input.environmentId, input.profileId].join("\u0000");
}

function cloneAuthorization(input: ArchitectureTargetBindingAuthorization): ArchitectureTargetBindingAuthorization {
  return structuredClone(input);
}

function sanitizeTargetAuditDetails(input: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeAuditDetails(input);
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isSensitiveTargetAuditKey(key))
      .map(([key, item]) => [key, strip(item)]));
  };
  return strip(sanitized) as Record<string, unknown>;
}

const sensitiveTargetAuditKeyPattern = /(?:^|[^a-z0-9])(?:api-key|authorization|credential|cookie|password|private-key|secret|token|prompt|path|endpoint|url|package|content|config|root|body|source|raw|snapshot|payload|file|filename|directory|home|host|machine)(?:$|[^a-z0-9])/i;

function isSensitiveTargetAuditKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
  return sensitiveTargetAuditKeyPattern.test(normalized);
}
