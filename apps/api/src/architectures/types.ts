import {
  architectureAccessPolicyVersion,
  evaluateArchitectureAccess as evaluateCoreArchitectureAccess,
  validateArchitectureOwnerReference as validateCoreArchitectureOwnerReference,
  type ArchitectureAccessAction,
  type ArchitectureAccessEvaluation,
  type ArchitectureAccessReason,
  type ArchitectureAccessRole,
  type ArchitectureOrganizationGrantContext,
  type ArchitectureOrganizationMembership,
  type ArchitectureOwnerReference,
  type ArchitecturePolicyInput,
  type ArchitecturePolicyActor,
  type ArchitectureTeamMembership,
  type ArchitectureOwnerReferenceType,
  type ArchitectureSpecV1,
  type ArchitecturePatternId,
} from "@myskills-app/core";

export type {
  ArchitectureEnvironment,
  ArchitectureAccess,
  ArchitectureAccessAction,
  ArchitectureAccessEvaluation,
  ArchitectureAccessReason,
  ArchitectureAccessRole,
  ArchitectureOrganizationGrantContext,
  ArchitectureOrganizationMembership,
  ArchitectureOwnerReference,
  ArchitectureOwnerReferenceType,
  ArchitecturePolicyActor,
  ArchitecturePattern,
  ArchitecturePatternId,
  ArchitectureProfile,
  ArchitectureProfileBinding,
  ArchitectureSkillRef,
  ArchitectureSpecV1,
  ArchitectureTeamMembership,
} from "@myskills-app/core";

export {
  architectureAccessActions,
  architectureAccessPolicyVersion,
  architectureAccessReasons,
  evaluateArchitecturePolicy,
  isArchitectureAccessAllowed,
  validateArchitectureOwnerReference,
  validateArchitecturePolicyInput,
} from "@myskills-app/core";

export type ArchitectureSpec = ArchitectureSpecV1;

/** Compatibility aliases keep API naming stable while core owns the policy vocabulary. */
export type ArchitectureOwnerRef = ArchitectureOwnerReference;
export type ArchitectureOwnerType = ArchitectureOwnerReferenceType;
export type ArchitectureTeamMemberRole = ArchitectureAccessRole;

/**
 * Actor context used by the store access boundary. Memberships are optional
 * because the Postgres store resolves them from the canonical team tables.
 * Memory callers can provide them directly for deterministic tests.
 */
export interface ArchitectureActor {
  id: string;
  roles?: readonly string[];
  teamMemberships?: readonly ArchitectureTeamMembership[];
  /** Current active organization memberships resolved by the store. */
  organizationMemberships?: readonly ArchitectureOrganizationMembership[];
  /** Compatibility shape used by the team service and browser callers. */
  teams?: readonly { id: string; role: ArchitectureTeamMemberRole }[];
  /** Team ids are read-only membership hints; they never grant write access. */
  teamIds?: readonly string[];
}

export type ArchitectureActorInput = ArchitectureActor | ArchitecturePolicyActor | string;

/** Core action names are canonical; list maps to the read capability. */
export type ArchitectureAction = ArchitectureAccessAction;
export type ArchitectureAccessDecision = ArchitectureAccessEvaluation;

/** Access facts returned with records, without exposing membership internals. */
export interface ArchitectureAccessMetadata {
  owner: ArchitectureOwnerReference;
  ownerType: ArchitectureOwnerType;
  ownerId: string;
  policyVersion: number;
  accessPolicyVersion: number;
  role: ArchitectureAccessRole | "none";
  canList: boolean;
  canRead: boolean;
  canPreview: boolean;
  canCreate: boolean;
  canAppend: boolean;
  canManage: boolean;
  reasons: ArchitectureAccessReason[];
  /** Sorted organization grants that currently authorize read/preview. */
  allowedOrganizationIds: string[];
}

/** Inputs may use the explicit ref or the legacy nullable owner columns. */
export interface ArchitectureOwnerInput {
  owner?: ArchitectureOwnerReference;
  ownerRef?: ArchitectureOwnerReference;
  ownerType?: ArchitectureOwnerType;
  ownerId?: string;
  ownerUserId?: string | null;
  ownerTeamId?: string | null;
}

export interface ArchitectureRecord {
  id: string;
  /** Legacy user owner column; null for a team-owned architecture. */
  ownerUserId: string | null;
  /** Team owner column added by the tenancy migration; null for user-owned. */
  ownerTeamId: string | null;
  owner: ArchitectureOwnerReference;
  ownerType: ArchitectureOwnerType;
  ownerId: string;
  accessPolicyVersion: number;
  access: ArchitectureAccessMetadata;
  name: string;
  description: string;
  patternId: ArchitecturePatternId;
  currentRevisionId: string | null;
  revisionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArchitectureRevisionRecord {
  id: string;
  architectureId: string;
  revisionNumber: number;
  message: string;
  spec: ArchitectureSpec;
  createdByUserId: string;
  createdAt: string;
  access?: ArchitectureAccessMetadata;
}

/**
 * Server-derived exact release metadata carried from route preflight to the
 * persistence boundary. It is never accepted from an HTTP request.
 */
export interface ArchitectureRevisionAuthorizationRelease {
  id: string;
  slug: string;
  version: string;
  digest: string;
  packageVisibility: ArchitectureSpec["skills"][number]["packageVisibility"];
}

/**
 * Immutable authorization intent for one revision append. The Postgres store
 * binds this intent to a fresh local registry and tenancy snapshot in its
 * transaction before inserting the immutable revision.
 */
export interface ArchitectureRevisionAuthorizationSnapshot {
  actorId: string;
  architectureId: string;
  owner: ArchitectureOwnerReference;
  organizationIds: readonly string[];
  releases: readonly ArchitectureRevisionAuthorizationRelease[];
}

export interface ArchitectureAuditEvent {
  id: string;
  actorUserId: string | null;
  action: string;
  decision: "allow" | "deny";
  resourceType: string;
  resourceId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ArchitectureAuditInput {
  actorUserId: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  details?: Record<string, unknown>;
}

export interface CreateArchitectureInput extends ArchitectureOwnerInput {
  actor?: ArchitectureActorInput;
  name: string;
  description: string;
  patternId: ArchitecturePatternId;
}

export interface CreateArchitectureRevisionInput extends ArchitectureOwnerInput {
  actor?: ArchitectureActorInput;
  architectureId: string;
  /** Optimistic-concurrency token; null is valid only before the first revision. */
  expectedCurrentRevisionId: string | null;
  message: string;
  spec: ArchitectureSpec;
  /** Internal server-derived exact-release intent; never parsed from HTTP. */
  authorizationSnapshot?: ArchitectureRevisionAuthorizationSnapshot;
}

export interface ArchitectureAccessLookup {
  actor: ArchitectureActorInput;
  owner: ArchitectureOwnerReference;
  action: ArchitectureAction;
  organizationVisibilityEnabled?: boolean;
  organizationGrantContexts?: readonly ArchitectureOrganizationGrantContext[];
}

export interface ArchitectureMembershipStore {
  findMembership(input: { teamId: string; userId: string }): Promise<{ role: ArchitectureTeamMemberRole } | null>;
  listTeamsForUser?(userId: string): Promise<readonly { id: string; role: ArchitectureTeamMemberRole }[]>;
}

export interface ArchitectureStore {
  readonly kind: "memory" | "postgres";
  listArchitectures(actor: ArchitectureActorInput): Promise<ArchitectureRecord[]>;
  getArchitecture(actor: ArchitectureActorInput, architectureId: string): Promise<ArchitectureRecord | null>;
  listRevisions(actor: ArchitectureActorInput, architectureId: string): Promise<ArchitectureRevisionRecord[] | null>;
  getRevision(actor: ArchitectureActorInput, architectureId: string, revisionId?: string): Promise<ArchitectureRevisionRecord | null>;
  /**
   * Read a revision for the internal preview compiler. Organization-only
   * callers must select one exact current organization grant; owner/team
   * callers retain the existing preview behavior without a context.
   */
  getRevisionForPreview(
    actor: ArchitectureActorInput,
    architectureId: string,
    revisionId?: string,
    organizationId?: string | null,
  ): Promise<ArchitectureRevisionRecord | null>;
  createArchitecture(input: CreateArchitectureInput): Promise<ArchitectureRecord>;
  /** When supplied, the allow audit is committed with the new shell. */
  createArchitecture(actor: ArchitectureActorInput, input: CreateArchitectureInput, audit?: ArchitectureAuditInput): Promise<ArchitectureRecord>;
  createRevision(input: CreateArchitectureRevisionInput): Promise<ArchitectureRevisionRecord | null>;
  /** When supplied, the allow audit is committed with the revision and pointer. */
  createRevision(actor: ArchitectureActorInput, input: CreateArchitectureRevisionInput, audit?: ArchitectureAuditInput): Promise<ArchitectureRevisionRecord | null>;
  recordAuditEvent(input: ArchitectureAuditInput): Promise<void>;
  listAuditEvents(limit?: number): Promise<ArchitectureAuditEvent[]>;
}

/**
 * Centralized adapter around the framework-neutral core evaluator. Stores
 * resolve membership rows before calling this function; no store or token
 * policy is duplicated here.
 */
export function evaluateArchitectureAccess(
  actorOrLookup: ArchitectureActorInput | ArchitectureAccessLookup | ArchitectureRecord,
  ownerOrActor?: ArchitectureOwnerReference | ArchitectureActorInput,
  action?: ArchitectureAction,
): ArchitectureAccessDecision {
  const lookup = isAccessLookup(actorOrLookup)
    ? actorOrLookup
    : isArchitectureRecord(actorOrLookup)
      ? { actor: ownerOrActor as ArchitectureActorInput, owner: ownerReferenceFromRecord(actorOrLookup), action: action ?? "read" }
      : { actor: actorOrLookup, owner: ownerOrActor as ArchitectureOwnerReference, action: action ?? "read" };
  const owner = normalizeOwnerReference(lookup.owner);
  if (!owner) {
    return {
      owner: { type: "user", id: "" },
      accessPolicyVersion: architectureAccessPolicyVersion,
      action: lookup.action,
      allowed: false,
      reason: "not-owner",
    };
  }
  return evaluateCoreArchitectureAccess({
    owner,
    actor: toArchitecturePolicyActor(lookup.actor),
    action: lookup.action,
    ...(lookup.organizationVisibilityEnabled === undefined
      ? {}
      : { organizationVisibilityEnabled: lookup.organizationVisibilityEnabled }),
    ...(lookup.organizationGrantContexts === undefined
      ? {}
      : { organizationGrantContexts: lookup.organizationGrantContexts }),
  });
}

/** Boolean helper for callers that do not need the explainable decision. */
export function canAccessArchitecture(
  actor: ArchitectureActorInput,
  owner: ArchitectureOwnerReference,
  action: ArchitectureAction,
): boolean {
  return evaluateArchitectureAccess(actor, owner, action).allowed;
}

export function architectureAccessForRecord(
  actor: ArchitectureActorInput,
  record: Pick<ArchitectureRecord, "owner" | "ownerType" | "ownerId" | "accessPolicyVersion">,
  organizationAccess: Pick<ArchitecturePolicyInput, "organizationVisibilityEnabled" | "organizationGrantContexts"> = {},
): ArchitectureAccessMetadata {
  const owner = normalizeOwnerReference(record.owner) ?? { type: record.ownerType, id: record.ownerId };
  const accessInput = { actor, owner, ...organizationAccess };
  const read = evaluateArchitectureAccess({ ...accessInput, action: "read" });
  const preview = evaluateArchitectureAccess({ ...accessInput, action: "preview" });
  const create = evaluateArchitectureAccess({ ...accessInput, action: "create" });
  const append = evaluateArchitectureAccess({ ...accessInput, action: "append-revision" });
  const manage = evaluateArchitectureAccess({ ...accessInput, action: "manage-policy" });
  const allowedOrganizationIds = [...new Set(read.allowedOrganizationIds ?? [])]
    .sort((left, right) => left.localeCompare(right));
  const role: ArchitectureAccessRole | "none" = read.reason === "owner" || read.reason === "team-owner"
    ? "owner"
    : read.reason === "team-member" ? "member" : "none";
  const access: ArchitectureAccessMetadata = {
    owner,
    ownerType: owner.type,
    ownerId: owner.id,
    policyVersion: record.accessPolicyVersion,
    accessPolicyVersion: record.accessPolicyVersion,
    role,
    canList: read.allowed,
    canRead: read.allowed,
    canPreview: preview.allowed,
    canCreate: create.allowed,
    canAppend: append.allowed,
    canManage: manage.allowed,
    reasons: read.allowed ? [read.reason] : [],
    allowedOrganizationIds,
  };
  return access;
}

export function normalizeArchitectureActor(input: ArchitectureActorInput): ArchitectureActor {
  if (typeof input === "string") return { id: input };
  if ("userId" in input) {
    return {
      id: input.userId,
      teamMemberships: input.teamMemberships,
      organizationMemberships: input.organizationMemberships,
    };
  }
  return input;
}

export function toArchitecturePolicyActor(input: ArchitectureActorInput): ArchitecturePolicyActor {
  const actor = normalizeArchitectureActor(input);
  const memberships = new Map<string, ArchitectureTeamMembership>();
  for (const membership of actor.teamMemberships ?? []) {
    const current = memberships.get(membership.teamId);
    memberships.set(membership.teamId, {
      teamId: membership.teamId,
      role: current?.role === "owner" || membership.role === "owner" ? "owner" : membership.role,
    });
  }
  for (const team of actor.teams ?? []) {
    const current = memberships.get(team.id);
    memberships.set(team.id, {
      teamId: team.id,
      role: current?.role === "owner" || team.role === "owner" ? "owner" : team.role,
    });
  }
  for (const teamId of actor.teamIds ?? []) {
    if (!memberships.has(teamId)) memberships.set(teamId, { teamId, role: "member" });
  }
  const organizationMemberships = new Map<string, ArchitectureOrganizationMembership>();
  for (const membership of actor.organizationMemberships ?? []) {
    const current = organizationMemberships.get(membership.organizationId);
    organizationMemberships.set(membership.organizationId, {
      organizationId: membership.organizationId,
      role: strongerOrganizationRole(current?.role, membership.role),
    });
  }
  return {
    userId: actor.id,
    teamMemberships: [...memberships.values()].sort((left, right) => left.teamId.localeCompare(right.teamId)),
    organizationMemberships: [...organizationMemberships.values()].sort((left, right) => left.organizationId.localeCompare(right.organizationId)),
  };
}

function strongerOrganizationRole(
  current: ArchitectureOrganizationMembership["role"] | undefined,
  next: ArchitectureOrganizationMembership["role"],
): ArchitectureOrganizationMembership["role"] {
  if (current === "owner" || next === "owner") return "owner";
  if (current === "admin" || next === "admin") return "admin";
  return "member";
}

export function normalizeOwnerReference(input: ArchitectureOwnerReference | ArchitectureOwnerInput | undefined): ArchitectureOwnerReference | null {
  if (!input) return null;
  let candidate: ArchitectureOwnerReference | null = null;
  if ("type" in input && (input.type === "user" || input.type === "team") && typeof input.id === "string") {
    candidate = { type: input.type, id: input.id };
  } else if ("owner" in input && input.owner) {
    return normalizeOwnerReference(input.owner);
  } else if ("ownerRef" in input && input.ownerRef) {
    return normalizeOwnerReference(input.ownerRef);
  } else if ((input as ArchitectureOwnerInput).ownerType && typeof (input as ArchitectureOwnerInput).ownerId === "string") {
    const ownerInput = input as ArchitectureOwnerInput;
    candidate = { type: ownerInput.ownerType as ArchitectureOwnerType, id: ownerInput.ownerId as string };
  } else {
    const ownerInput = input as ArchitectureOwnerInput;
    const hasUser = typeof ownerInput.ownerUserId === "string" && ownerInput.ownerUserId.length > 0;
    const hasTeam = typeof ownerInput.ownerTeamId === "string" && ownerInput.ownerTeamId.length > 0;
    if (hasUser === hasTeam) return null;
    candidate = hasUser
      ? { type: "user", id: ownerInput.ownerUserId as string }
      : { type: "team", id: ownerInput.ownerTeamId as string };
  }
  if (!candidate) return null;
  const result = validateCoreArchitectureOwnerReference(candidate);
  return result.valid ? result.value : null;
}

function isAccessLookup(input: unknown): input is ArchitectureAccessLookup {
  return Boolean(input && typeof input === "object" && "actor" in input && "owner" in input && "action" in input);
}

function isArchitectureRecord(input: unknown): input is ArchitectureRecord {
  return Boolean(input && typeof input === "object" && "owner" in input && "ownerType" in input && "ownerId" in input);
}

function ownerReferenceFromRecord(record: ArchitectureRecord): ArchitectureOwnerReference {
  return normalizeOwnerReference(record.owner) ?? { type: record.ownerType, id: record.ownerId };
}
