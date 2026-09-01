import type {
  ArchitectureTarget,
  ArchitectureTargetAccessAction,
  ArchitectureTargetAccessEvaluation,
  ArchitectureTargetAdapterDescriptor,
  ArchitectureTargetCapabilities,
  ArchitectureTargetHealth,
  ArchitectureTargetObservation,
  ArchitectureTargetObservationInput,
  ArchitectureTargetOrganizationMembership,
  ArchitectureTargetOwnerReference,
  ArchitectureTargetTeamMembership,
  ArchitectureTargetMetadata,
} from "@myskills-app/core";

export type {
  ArchitectureTarget,
  ArchitectureTargetAccessAction,
  ArchitectureTargetAccessEvaluation,
  ArchitectureTargetAdapterDescriptor,
  ArchitectureTargetCapabilities,
  ArchitectureTargetHealth,
  ArchitectureTargetObservation,
  ArchitectureTargetObservationInput,
  ArchitectureTargetOrganizationMembership,
  ArchitectureTargetOwnerReference,
  ArchitectureTargetTeamMembership,
  ArchitectureTargetMetadata,
} from "@myskills-app/core";

/**
 * Target operations accept only an actor id. Memberships supplied by a
 * browser or adapter are intentionally not part of this input: the store
 * resolves the current memberships from its authority on every call.
 */
export type ArchitectureTargetActorInput = string | { id?: string; userId?: string };

export interface ArchitectureTargetActor {
  userId: string;
}

/** Current team membership authority used by target policy evaluation. */
export interface ArchitectureTargetMembershipResolver {
  listTeamMemberships(userId: string): Promise<readonly ArchitectureTargetTeamMembership[]>;
  listOrganizationMemberships(userId: string): Promise<readonly ArchitectureTargetOrganizationMembership[]>;
}

/**
 * The binding authorizer is deliberately narrower than a general architecture
 * authorization service. It resolves the authoritative binding and owner after
 * checking that the actor can use the requested architecture context.
 */
export interface ArchitectureTargetBindingRequest {
  actor: ArchitectureTargetActor;
  actorUserId: string;
  /** The client-requested owner. It is input to the authorizer, never trust. */
  requestedOwner: ArchitectureTargetOwnerReference;
  /** Alias makes the request clear to adapters that use owner terminology. */
  owner: ArchitectureTargetOwnerReference;
  architectureId: string;
  environmentId: string;
  profileId: string;
}

export interface ArchitectureTargetBinding {
  owner: ArchitectureTargetOwnerReference;
  architectureId: string;
  environmentId: string;
  profileId: string;
}

/**
 * Non-secret authorization context captured immediately before registration.
 * PostgreSQL rechecks this context while holding the architecture lock so a
 * membership, grant, policy, or current-revision change cannot widen a stale
 * preflight decision into a persisted target.
 */
export interface ArchitectureTargetBindingAuthorizationContext {
  actorUserId: string;
  owner: ArchitectureTargetOwnerReference;
  architectureId: string;
  environmentId: string;
  profileId: string;
  currentRevisionId: string | null;
}

export interface ArchitectureTargetBindingAuthorization {
  allowed: boolean;
  /** Required for an allow. These values are authoritative, not client labels. */
  binding?: ArchitectureTargetBinding;
  /** Present on the production authorizer's allow path; never contains credentials. */
  authorization?: ArchitectureTargetBindingAuthorizationContext;
  reason?: string;
}

export interface ArchitectureTargetBindingAuthorizer {
  authorizeBinding(input: ArchitectureTargetBindingRequest): Promise<ArchitectureTargetBindingAuthorization>;
}

/** Public projection. Credential references are never present in this shape. */
export interface ArchitectureTargetRecord extends ArchitectureTarget {
  createdAt: string;
  updatedAt: string;
  health: ArchitectureTargetHealth | null;
}

/** Store-only input. The credential reference is never returned by a store. */
export interface RegisterArchitectureTargetStoreInput {
  target: ArchitectureTarget;
  credentialReference: string | null;
  /** Internal preflight context; Postgres requires it for registration. */
  authorization?: ArchitectureTargetBindingAuthorizationContext;
  /**
   * The required allow audit is committed with the target. Store
   * implementations must roll back the registration when this write fails.
   */
  audit: ArchitectureTargetAuditInput;
}

export type ArchitectureTargetConsentDecision = "grant" | "deny";

export interface RegisterArchitectureTargetInput {
  actor: ArchitectureTargetActorInput;
  name: string;
  owner?: ArchitectureTargetOwnerReference;
  architectureId: string;
  environmentId: string;
  profileId: string;
  adapter: ArchitectureTargetAdapterDescriptor;
  capabilities: ArchitectureTargetCapabilities;
  /** An already opaque adapter identity digest. A digest is generated when omitted. */
  identityDigest?: string;
  /** Opaque reference into an approved secret store; never a secret or path. */
  credentialReference?: string | null;
  metadata?: ArchitectureTargetMetadata;
}

export interface SetArchitectureTargetConsentInput {
  actor: ArchitectureTargetActorInput;
  targetId: string;
  decision: ArchitectureTargetConsentDecision;
}

/**
 * Store-only consent mutation input. The allow audit is persisted in the same
 * transaction as the state change; callers cannot commit consent without it.
 */
export interface SetArchitectureTargetConsentStoreInput {
  actor: ArchitectureTargetActorInput;
  targetId: string;
  decision: ArchitectureTargetConsentDecision;
  audit: ArchitectureTargetAuditInput;
}

export interface AppendArchitectureTargetObservationInput {
  actor: ArchitectureTargetActorInput;
  targetId: string;
  observation: ArchitectureTargetObservationInput;
}

/** Store-only observation mutation input with its required allow audit. */
export interface AppendArchitectureTargetObservationStoreInput {
  actor: ArchitectureTargetActorInput;
  targetId: string;
  observation: ArchitectureTargetObservation;
  audit: ArchitectureTargetAuditInput;
}

export interface UpdateArchitectureTargetHealthInput {
  actor: ArchitectureTargetActorInput;
  targetId: string;
  health: ArchitectureTargetHealth;
}

/** Store-only health mutation input with its required allow audit. */
export interface UpdateArchitectureTargetHealthStoreInput {
  actor: ArchitectureTargetActorInput;
  targetId: string;
  health: ArchitectureTargetHealth;
  audit: ArchitectureTargetAuditInput;
}

export interface RevokeArchitectureTargetInput {
  actor: ArchitectureTargetActorInput;
  targetId: string;
}

/** Store-only revoke mutation input with its required allow audit. */
export interface RevokeArchitectureTargetStoreInput {
  actor: ArchitectureTargetActorInput;
  targetId: string;
  audit: ArchitectureTargetAuditInput;
}

export interface ArchitectureTargetAuditInput {
  actorUserId: string;
  action: string;
  decision: "allow" | "deny";
  targetId?: string | null;
  details?: Record<string, unknown>;
}

export interface ArchitectureTargetAuditEvent extends ArchitectureTargetAuditInput {
  id: string;
  targetId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

/**
 * Persistence boundary for target operations. Implementations must resolve
 * memberships afresh before each access decision and must never return the
 * private credential reference.
 */
export interface ArchitectureTargetStore {
  readonly kind: "memory" | "postgres";
  listTargets(actor: ArchitectureTargetActorInput): Promise<ArchitectureTargetRecord[]>;
  getTarget(actor: ArchitectureTargetActorInput, targetId: string): Promise<ArchitectureTargetRecord | null>;
  getTargetAccess(
    actor: ArchitectureTargetActorInput,
    targetId: string,
    action: ArchitectureTargetAccessAction,
  ): Promise<ArchitectureTargetAccessEvaluation | null>;
  registerTarget(input: RegisterArchitectureTargetStoreInput): Promise<ArchitectureTargetRecord>;
  setConsent(input: SetArchitectureTargetConsentStoreInput): Promise<ArchitectureTargetRecord | null>;
  appendObservation(input: AppendArchitectureTargetObservationStoreInput): Promise<ArchitectureTargetObservation | null>;
  listObservations(input: {
    actor: ArchitectureTargetActorInput;
    targetId: string;
    limit?: number;
  }): Promise<ArchitectureTargetObservation[] | null>;
  updateHealth(input: UpdateArchitectureTargetHealthStoreInput): Promise<ArchitectureTargetRecord | null>;
  revokeTarget(input: RevokeArchitectureTargetStoreInput): Promise<ArchitectureTargetRecord | null>;
  recordAuditEvent(input: ArchitectureTargetAuditInput): Promise<void>;
  listAuditEvents(limit?: number): Promise<ArchitectureTargetAuditEvent[]>;
}

export interface ArchitectureTargetServiceOptions {
  now?: () => Date;
  idFactory?: () => string;
}
