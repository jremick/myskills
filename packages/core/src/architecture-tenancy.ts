/**
 * Framework-neutral ownership and access policy for skill architectures.
 *
 * This module describes the policy inputs and decisions only. It does not
 * resolve users or teams, query a store, inspect tokens, or mutate a resource.
 * Callers provide an already-authorized snapshot of the actor's memberships
 * and explicit organization grant contexts.
 */

import type {
  OrganizationPolicyV1,
  OrganizationStatus,
} from "./organization-tenancy.js";
import { validateOrganizationPolicyV1 } from "./organization-tenancy.js";

export const architectureAccessPolicyVersion = 1 as const;
export type ArchitectureAccessPolicyVersion = typeof architectureAccessPolicyVersion;

export const architectureOwnerReferenceTypes = ["user", "team"] as const;
export type ArchitectureOwnerReferenceType = (typeof architectureOwnerReferenceTypes)[number];

/** A stable user or team identity. It is intentionally not a database row. */
export interface ArchitectureOwnerReference {
  type: ArchitectureOwnerReferenceType;
  id: string;
}

/**
 * Phase 2A has only the existing team membership roles. More granular
 * collaboration roles require a separate policy decision and are not implied
 * by membership in this contract.
 */
export const architectureAccessRoles = ["owner", "member"] as const;
export type ArchitectureAccessRole = (typeof architectureAccessRoles)[number];
export type ArchitectureTeamRole = ArchitectureAccessRole;

// Descriptive aliases keep the vocabulary discoverable at team boundaries.
export const architectureTeamRoles = architectureAccessRoles;
export const architectureRoles = architectureAccessRoles;
export type ArchitectureRole = ArchitectureAccessRole;

/** Actions which can be checked against an architecture access decision. */
export const architectureAccessActions = [
  "read",
  "preview",
  "create",
  "append-revision",
  "manage-policy",
] as const;
export type ArchitectureAccessAction = (typeof architectureAccessActions)[number];

/**
 * Reasons identify the stable relationship used by the policy. They do not
 * reveal whether a hidden resource exists; callers can map a denial to their
 * own generic response at the API boundary.
 */
export const architectureAccessReasons = [
  "owner",
  "team-owner",
  "team-member",
  "organization",
  "not-owner",
  "not-team-member",
] as const;
export type ArchitectureAccessReason = (typeof architectureAccessReasons)[number];

export interface ArchitectureTeamMembership {
  teamId: string;
  role: ArchitectureTeamRole;
}

export const architectureOrganizationAccessRoles = ["owner", "admin", "member"] as const;
export type ArchitectureOrganizationAccessRole = (typeof architectureOrganizationAccessRoles)[number];
export type ArchitectureOrganizationMembershipRole = ArchitectureOrganizationAccessRole;

/** A current, active organization membership resolved by the store. */
export interface ArchitectureOrganizationMembership {
  organizationId: string;
  role: ArchitectureOrganizationAccessRole;
}

/**
 * A store-resolved organization grant and policy snapshot. The context is
 * explicit so a policy decision can prove that the grant was recorded under
 * a revision belonging to the same organization and that the current policy
 * pointer still belongs to that organization.
 */
export interface ArchitectureOrganizationGrantContext {
  organizationId: string;
  /** The database row is constrained to read; omitted means read in v1. */
  accessLevel?: "read";
  grantPolicyRevisionId: string;
  grantPolicyOrganizationId: string;
  organizationStatus: OrganizationStatus;
  currentPolicyRevisionId: string | null;
  currentPolicyOrganizationId: string | null;
  policy: OrganizationPolicyV1;
}

/**
 * The evaluator consumes a bounded, already-resolved actor snapshot. An
 * omitted membership list means that the actor belongs to no teams.
 */
export interface ArchitecturePolicyActor {
  userId: string;
  teamMemberships?: readonly ArchitectureTeamMembership[];
  organizationMemberships?: readonly ArchitectureOrganizationMembership[];
}

export interface ArchitecturePolicyInput {
  owner: ArchitectureOwnerReference;
  actor: ArchitecturePolicyActor;
  /** Instance-wide switch; absent is the secure, backwards-compatible off state. */
  organizationVisibilityEnabled?: boolean;
  /** Explicit, already-resolved organization grant contexts for this architecture. */
  organizationGrantContexts?: readonly ArchitectureOrganizationGrantContext[];
}

export interface ArchitectureAccess {
  canRead: boolean;
  canPreview: boolean;
  canAppendRevision: boolean;
  canManagePolicy: boolean;
  reason: ArchitectureAccessReason;
  /** Only organizations that pass every current access predicate are returned. */
  allowedOrganizationIds?: readonly string[];
}

/** The complete, deterministic capability projection for one actor/resource pair. */
export interface ArchitecturePolicyDecision {
  owner: ArchitectureOwnerReference;
  accessPolicyVersion: ArchitectureAccessPolicyVersion;
  access: ArchitectureAccess;
}

export interface ArchitectureAccessEvaluationInput extends ArchitecturePolicyInput {
  action: ArchitectureAccessAction;
}

/** The deterministic result of checking one action. */
export interface ArchitectureAccessEvaluation {
  owner: ArchitectureOwnerReference;
  accessPolicyVersion: ArchitectureAccessPolicyVersion;
  action: ArchitectureAccessAction;
  allowed: boolean;
  reason: ArchitectureAccessReason;
  allowedOrganizationIds?: readonly string[];
}

export type ArchitectureOwnershipPolicyInput = ArchitecturePolicyInput;
export type ArchitectureOwnershipPolicyDecision = ArchitecturePolicyDecision;

export type ArchitectureOwnershipValidationCode =
  | "ARCHITECTURE_OWNER_REFERENCE_INVALID"
  | "ARCHITECTURE_OWNER_TYPE_INVALID"
  | "ARCHITECTURE_OWNER_ID_INVALID"
  | "ARCHITECTURE_POLICY_INPUT_INVALID"
  | "ARCHITECTURE_POLICY_ACTOR_INVALID"
  | "ARCHITECTURE_POLICY_USER_ID_INVALID"
  | "ARCHITECTURE_POLICY_MEMBERSHIPS_INVALID"
  | "ARCHITECTURE_TEAM_MEMBERSHIP_INVALID"
  | "ARCHITECTURE_TEAM_ID_INVALID"
  | "ARCHITECTURE_TEAM_ROLE_INVALID"
  | "ARCHITECTURE_TEAM_MEMBERSHIP_DUPLICATE"
  | "ARCHITECTURE_POLICY_ORGANIZATION_VISIBILITY_INVALID"
  | "ARCHITECTURE_POLICY_ORGANIZATION_MEMBERSHIPS_INVALID"
  | "ARCHITECTURE_ORGANIZATION_MEMBERSHIP_INVALID"
  | "ARCHITECTURE_ORGANIZATION_ID_INVALID"
  | "ARCHITECTURE_ORGANIZATION_ROLE_INVALID"
  | "ARCHITECTURE_ORGANIZATION_MEMBERSHIP_DUPLICATE"
  | "ARCHITECTURE_POLICY_ORGANIZATION_GRANT_CONTEXTS_INVALID"
  | "ARCHITECTURE_ORGANIZATION_GRANT_CONTEXT_INVALID"
  | "ARCHITECTURE_ORGANIZATION_GRANT_ACCESS_LEVEL_INVALID"
  | "ARCHITECTURE_ORGANIZATION_GRANT_REVISION_ID_INVALID"
  | "ARCHITECTURE_ORGANIZATION_GRANT_REVISION_ORGANIZATION_INVALID"
  | "ARCHITECTURE_ORGANIZATION_STATUS_INVALID"
  | "ARCHITECTURE_ORGANIZATION_CURRENT_REVISION_ID_INVALID"
  | "ARCHITECTURE_ORGANIZATION_CURRENT_REVISION_ORGANIZATION_INVALID"
  | "ARCHITECTURE_ORGANIZATION_POLICY_INVALID"
  | "ARCHITECTURE_ACCESS_ACTION_INVALID";

export interface ArchitectureOwnershipValidationIssue {
  code: ArchitectureOwnershipValidationCode;
  message: string;
  path?: string;
}

export type ArchitectureOwnerReferenceValidationResult =
  | { valid: true; value: ArchitectureOwnerReference }
  | { valid: false; errors: ArchitectureOwnershipValidationIssue[] };

export type ArchitectureOrganizationGrantContextValidationResult =
  | { valid: true; value: ArchitectureOrganizationGrantContext }
  | { valid: false; errors: ArchitectureOwnershipValidationIssue[] };

export type ArchitecturePolicyInputValidationResult =
  | { valid: true; value: ArchitecturePolicyInput }
  | { valid: false; errors: ArchitectureOwnershipValidationIssue[] };

export class ArchitectureOwnershipValidationError extends Error {
  public readonly code = "ARCHITECTURE_OWNERSHIP_VALIDATION_FAILED";

  constructor(public readonly errors: ArchitectureOwnershipValidationIssue[]) {
    super(errors.map((error) => `${error.code}: ${error.message}`).join("; ") || "Architecture ownership input is invalid.");
    this.name = "ArchitectureOwnershipValidationError";
  }
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key)).sort();
}

function isArchitectureOwnerReferenceType(value: unknown): value is ArchitectureOwnerReferenceType {
  return typeof value === "string"
    && (architectureOwnerReferenceTypes as readonly string[]).includes(value);
}

function isArchitectureAccessRole(value: unknown): value is ArchitectureAccessRole {
  return typeof value === "string" && (architectureAccessRoles as readonly string[]).includes(value);
}

function isArchitectureAccessAction(value: unknown): value is ArchitectureAccessAction {
  return typeof value === "string" && (architectureAccessActions as readonly string[]).includes(value);
}

function isArchitectureOrganizationAccessRole(value: unknown): value is ArchitectureOrganizationAccessRole {
  return typeof value === "string" && (architectureOrganizationAccessRoles as readonly string[]).includes(value);
}

function isOrganizationStatus(value: unknown): value is OrganizationStatus {
  return typeof value === "string"
    && (["provisioning", "active", "suspended", "archived"] as readonly string[]).includes(value);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

function invalidOwnerResult(
  code: ArchitectureOwnershipValidationCode,
  message: string,
  path?: string,
): { valid: false; errors: ArchitectureOwnershipValidationIssue[] } {
  return { valid: false, errors: [{ code, message, ...(path ? { path } : {}) }] };
}

/** Validate and clone a user/team owner reference. */
export function validateArchitectureOwnerReference(input: unknown): ArchitectureOwnerReferenceValidationResult {
  if (!isRecord(input)) {
    return invalidOwnerResult(
      "ARCHITECTURE_OWNER_REFERENCE_INVALID",
      "Architecture owner must be an object.",
      "owner",
    );
  }

  const errors: ArchitectureOwnershipValidationIssue[] = [];
  for (const key of unknownKeys(input, ["type", "id"])) {
    errors.push({
      code: "ARCHITECTURE_OWNER_REFERENCE_INVALID",
      message: `Architecture owner field '${key}' is not accepted.`,
      path: `owner.${key}`,
    });
  }
  if (!isArchitectureOwnerReferenceType(input.type)) {
    errors.push({
      code: "ARCHITECTURE_OWNER_TYPE_INVALID",
      message: "Architecture owner type must be 'user' or 'team'.",
      path: "owner.type",
    });
  }
  if (!validIdentifier(input.id)) {
    errors.push({
      code: "ARCHITECTURE_OWNER_ID_INVALID",
      message: "Architecture owner id must be a bounded identifier.",
      path: "owner.id",
    });
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { type: input.type as ArchitectureOwnerReferenceType, id: input.id as string } };
}

/** Type guard for untrusted owner-reference-shaped values. */
export function isArchitectureOwnerReference(input: unknown): input is ArchitectureOwnerReference {
  return validateArchitectureOwnerReference(input).valid;
}

/**
 * Validate one already-resolved organization grant context. Stores should
 * construct these from the grant row, the current organization policy row,
 * and current active membership rows; callers must not derive them from
 * organization labels or team parentage.
 */
export function validateArchitectureOrganizationGrantContext(
  input: unknown,
  pathPrefix = "organizationGrantContext",
): ArchitectureOrganizationGrantContextValidationResult {
  if (!isRecord(input)) {
    return {
      valid: false,
      errors: [{
        code: "ARCHITECTURE_ORGANIZATION_GRANT_CONTEXT_INVALID",
        message: "Architecture organization grant context must be an object.",
        path: pathPrefix,
      }],
    };
  }

  const errors: ArchitectureOwnershipValidationIssue[] = [];
  for (const key of unknownKeys(input, [
    "organizationId",
    "accessLevel",
    "grantPolicyRevisionId",
    "grantPolicyOrganizationId",
    "organizationStatus",
    "currentPolicyRevisionId",
    "currentPolicyOrganizationId",
    "policy",
  ])) {
    errors.push({
      code: "ARCHITECTURE_ORGANIZATION_GRANT_CONTEXT_INVALID",
      message: `Architecture organization grant context field '${key}' is not accepted.`,
      path: `${pathPrefix}.${key}`,
    });
  }
  if (!validIdentifier(input.organizationId)) {
    errors.push({
      code: "ARCHITECTURE_ORGANIZATION_ID_INVALID",
      message: "Architecture organization id must be a bounded identifier.",
      path: `${pathPrefix}.organizationId`,
    });
  }
  if (input.accessLevel !== undefined && input.accessLevel !== "read") {
    errors.push({
      code: "ARCHITECTURE_ORGANIZATION_GRANT_ACCESS_LEVEL_INVALID",
      message: "Architecture organization grants must use read access.",
      path: `${pathPrefix}.accessLevel`,
    });
  }
  if (!validIdentifier(input.grantPolicyRevisionId)) {
    errors.push({
      code: "ARCHITECTURE_ORGANIZATION_GRANT_REVISION_ID_INVALID",
      message: "Architecture organization grant policy revision id must be a bounded identifier.",
      path: `${pathPrefix}.grantPolicyRevisionId`,
    });
  }
  if (!validIdentifier(input.grantPolicyOrganizationId)) {
    errors.push({
      code: "ARCHITECTURE_ORGANIZATION_GRANT_REVISION_ORGANIZATION_INVALID",
      message: "Architecture organization grant policy organization id must be a bounded identifier.",
      path: `${pathPrefix}.grantPolicyOrganizationId`,
    });
  }
  if (!isOrganizationStatus(input.organizationStatus)) {
    errors.push({
      code: "ARCHITECTURE_ORGANIZATION_STATUS_INVALID",
      message: "Architecture organization status is unsupported.",
      path: `${pathPrefix}.organizationStatus`,
    });
  }
  if (input.currentPolicyRevisionId !== null && !validIdentifier(input.currentPolicyRevisionId)) {
    errors.push({
      code: "ARCHITECTURE_ORGANIZATION_CURRENT_REVISION_ID_INVALID",
      message: "Architecture organization current policy revision id must be a bounded identifier or null.",
      path: `${pathPrefix}.currentPolicyRevisionId`,
    });
  }
  if (input.currentPolicyOrganizationId !== null && !validIdentifier(input.currentPolicyOrganizationId)) {
    errors.push({
      code: "ARCHITECTURE_ORGANIZATION_CURRENT_REVISION_ORGANIZATION_INVALID",
      message: "Architecture organization current policy organization id must be a bounded identifier or null.",
      path: `${pathPrefix}.currentPolicyOrganizationId`,
    });
  }

  const policyResult = validateOrganizationPolicyV1(input.policy);
  if (!policyResult.valid) {
    errors.push({
      code: "ARCHITECTURE_ORGANIZATION_POLICY_INVALID",
      message: "Architecture organization current policy is invalid.",
      path: `${pathPrefix}.policy`,
    });
  }
  if (
    errors.length > 0
    || !validIdentifier(input.organizationId)
    || !validIdentifier(input.grantPolicyRevisionId)
    || !validIdentifier(input.grantPolicyOrganizationId)
    || !isOrganizationStatus(input.organizationStatus)
    || (input.currentPolicyRevisionId !== null && !validIdentifier(input.currentPolicyRevisionId))
    || (input.currentPolicyOrganizationId !== null && !validIdentifier(input.currentPolicyOrganizationId))
    || !policyResult.valid
  ) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      organizationId: input.organizationId,
      ...(input.accessLevel === undefined ? {} : { accessLevel: "read" as const }),
      grantPolicyRevisionId: input.grantPolicyRevisionId,
      grantPolicyOrganizationId: input.grantPolicyOrganizationId,
      organizationStatus: input.organizationStatus,
      currentPolicyRevisionId: input.currentPolicyRevisionId,
      currentPolicyOrganizationId: input.currentPolicyOrganizationId,
      policy: {
        schemaVersion: policyResult.value.schemaVersion,
        sharing: { ...policyResult.value.sharing },
        teams: { ...policyResult.value.teams },
        limits: { ...policyResult.value.limits },
      },
    },
  };
}

export function assertValidArchitectureOrganizationGrantContext(input: unknown): ArchitectureOrganizationGrantContext {
  const result = validateArchitectureOrganizationGrantContext(input);
  if (!result.valid) throw new ArchitectureOwnershipValidationError(result.errors);
  return result.value;
}

/** Validate and normalize an actor/owner policy input. */
export function validateArchitecturePolicyInput(input: unknown): ArchitecturePolicyInputValidationResult {
  if (!isRecord(input)) {
    return invalidOwnerResult(
      "ARCHITECTURE_POLICY_INPUT_INVALID",
      "Architecture policy input must be an object.",
    );
  }

  const errors: ArchitectureOwnershipValidationIssue[] = [];
  for (const key of unknownKeys(input, ["owner", "actor", "organizationVisibilityEnabled", "organizationGrantContexts"])) {
    errors.push({
      code: "ARCHITECTURE_POLICY_INPUT_INVALID",
      message: `Architecture policy field '${key}' is not accepted.`,
      path: key,
    });
  }

  if (input.organizationVisibilityEnabled !== undefined && typeof input.organizationVisibilityEnabled !== "boolean") {
    errors.push({
      code: "ARCHITECTURE_POLICY_ORGANIZATION_VISIBILITY_INVALID",
      message: "Architecture organization visibility must be boolean.",
      path: "organizationVisibilityEnabled",
    });
  }

  const ownerResult = validateArchitectureOwnerReference(input.owner);
  if (!ownerResult.valid) errors.push(...ownerResult.errors);

  let normalizedActor: ArchitecturePolicyActor | undefined;
  if (!isRecord(input.actor)) {
    errors.push({
      code: "ARCHITECTURE_POLICY_ACTOR_INVALID",
      message: "Architecture policy actor must be an object.",
      path: "actor",
    });
  } else {
    for (const key of unknownKeys(input.actor, ["userId", "teamMemberships", "organizationMemberships"])) {
      errors.push({
        code: "ARCHITECTURE_POLICY_ACTOR_INVALID",
        message: `Architecture policy actor field '${key}' is not accepted.`,
        path: `actor.${key}`,
      });
    }
    if (!validIdentifier(input.actor.userId)) {
      errors.push({
        code: "ARCHITECTURE_POLICY_USER_ID_INVALID",
        message: "Architecture policy actor userId must be a bounded identifier.",
        path: "actor.userId",
      });
    }

    const memberships = input.actor.teamMemberships;
    if (memberships !== undefined && !Array.isArray(memberships)) {
      errors.push({
        code: "ARCHITECTURE_POLICY_MEMBERSHIPS_INVALID",
        message: "Architecture policy teamMemberships must be an array.",
        path: "actor.teamMemberships",
      });
    } else {
      const normalizedMemberships: ArchitectureTeamMembership[] = [];
      const seenTeamIds = new Set<string>();
      for (const [index, membership] of (memberships ?? []).entries()) {
        const path = `actor.teamMemberships[${index}]`;
        if (!isRecord(membership)) {
          errors.push({
            code: "ARCHITECTURE_TEAM_MEMBERSHIP_INVALID",
            message: "Architecture team membership must be an object.",
            path,
          });
          continue;
        }
        for (const key of unknownKeys(membership, ["teamId", "role"])) {
          errors.push({
            code: "ARCHITECTURE_TEAM_MEMBERSHIP_INVALID",
            message: `Architecture team membership field '${key}' is not accepted.`,
            path: `${path}.${key}`,
          });
        }
        if (!validIdentifier(membership.teamId)) {
          errors.push({
            code: "ARCHITECTURE_TEAM_ID_INVALID",
            message: "Architecture team membership teamId must be a bounded identifier.",
            path: `${path}.teamId`,
          });
        }
        if (!isArchitectureAccessRole(membership.role)) {
          errors.push({
            code: "ARCHITECTURE_TEAM_ROLE_INVALID",
            message: "Architecture team membership role must be 'owner' or 'member'.",
            path: `${path}.role`,
          });
        }
        if (validIdentifier(membership.teamId) && seenTeamIds.has(membership.teamId)) {
          errors.push({
            code: "ARCHITECTURE_TEAM_MEMBERSHIP_DUPLICATE",
            message: "Architecture team memberships must contain one entry per team.",
            path: `${path}.teamId`,
          });
        }
        if (validIdentifier(membership.teamId)) seenTeamIds.add(membership.teamId);
        if (validIdentifier(membership.teamId) && isArchitectureAccessRole(membership.role)) {
          normalizedMemberships.push({ teamId: membership.teamId, role: membership.role });
        }
      }
      normalizedMemberships.sort((left, right) => {
        if (left.teamId < right.teamId) return -1;
        if (left.teamId > right.teamId) return 1;
        return 0;
      });
      const organizationMemberships = input.actor.organizationMemberships;
      if (organizationMemberships !== undefined && !Array.isArray(organizationMemberships)) {
        errors.push({
          code: "ARCHITECTURE_POLICY_ORGANIZATION_MEMBERSHIPS_INVALID",
          message: "Architecture policy actor organizationMemberships must be an array.",
          path: "actor.organizationMemberships",
        });
      }
      const normalizedOrganizationMemberships: ArchitectureOrganizationMembership[] = [];
      const seenOrganizationIds = new Set<string>();
      for (const [index, membership] of (Array.isArray(organizationMemberships) ? organizationMemberships : []).entries()) {
        const path = `actor.organizationMemberships[${index}]`;
        if (!isRecord(membership)) {
          errors.push({
            code: "ARCHITECTURE_ORGANIZATION_MEMBERSHIP_INVALID",
            message: "Architecture organization membership must be an object.",
            path,
          });
          continue;
        }
        for (const key of unknownKeys(membership, ["organizationId", "role"])) {
          errors.push({
            code: "ARCHITECTURE_ORGANIZATION_MEMBERSHIP_INVALID",
            message: `Architecture organization membership field '${key}' is not accepted.`,
            path: `${path}.${key}`,
          });
        }
        if (!validIdentifier(membership.organizationId)) {
          errors.push({
            code: "ARCHITECTURE_ORGANIZATION_ID_INVALID",
            message: "Architecture organization membership organizationId must be a bounded identifier.",
            path: `${path}.organizationId`,
          });
        }
        if (!isArchitectureOrganizationAccessRole(membership.role)) {
          errors.push({
            code: "ARCHITECTURE_ORGANIZATION_ROLE_INVALID",
            message: "Architecture organization membership role must be 'owner', 'admin', or 'member'.",
            path: `${path}.role`,
          });
        }
        if (validIdentifier(membership.organizationId) && seenOrganizationIds.has(membership.organizationId)) {
          errors.push({
            code: "ARCHITECTURE_ORGANIZATION_MEMBERSHIP_DUPLICATE",
            message: "Architecture organization memberships must contain one entry per organization.",
            path: `${path}.organizationId`,
          });
        }
        if (validIdentifier(membership.organizationId)) seenOrganizationIds.add(membership.organizationId);
        if (validIdentifier(membership.organizationId) && isArchitectureOrganizationAccessRole(membership.role)) {
          normalizedOrganizationMemberships.push({
            organizationId: membership.organizationId,
            role: membership.role,
          });
        }
      }
      normalizedOrganizationMemberships.sort((left, right) => left.organizationId.localeCompare(right.organizationId));
      normalizedActor = {
        userId: typeof input.actor.userId === "string" ? input.actor.userId : "",
        teamMemberships: normalizedMemberships,
        organizationMemberships: normalizedOrganizationMemberships,
      };
    }
  }

  const rawGrantContexts = input.organizationGrantContexts;
  if (rawGrantContexts !== undefined && !Array.isArray(rawGrantContexts)) {
    errors.push({
      code: "ARCHITECTURE_POLICY_ORGANIZATION_GRANT_CONTEXTS_INVALID",
      message: "Architecture organizationGrantContexts must be an array.",
      path: "organizationGrantContexts",
    });
  }
  const normalizedGrantContexts: ArchitectureOrganizationGrantContext[] = [];
  const seenGrantOrganizationIds = new Set<string>();
  for (const [index, context] of (Array.isArray(rawGrantContexts) ? rawGrantContexts : []).entries()) {
    const result = validateArchitectureOrganizationGrantContext(context, `organizationGrantContexts[${index}]`);
    if (!result.valid) {
      errors.push(...result.errors);
      continue;
    }
    if (seenGrantOrganizationIds.has(result.value.organizationId)) {
      errors.push({
        code: "ARCHITECTURE_POLICY_ORGANIZATION_GRANT_CONTEXTS_INVALID",
        message: "Architecture organization grant contexts must contain one entry per organization.",
        path: `organizationGrantContexts[${index}].organizationId`,
      });
      continue;
    }
    seenGrantOrganizationIds.add(result.value.organizationId);
    normalizedGrantContexts.push(result.value);
  }
  normalizedGrantContexts.sort((left, right) => left.organizationId.localeCompare(right.organizationId));

  if (errors.length > 0 || !ownerResult.valid || !normalizedActor) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      owner: ownerResult.value,
      actor: normalizedActor,
      ...(input.organizationVisibilityEnabled === undefined
        ? {}
        : { organizationVisibilityEnabled: input.organizationVisibilityEnabled as boolean }),
      ...(rawGrantContexts === undefined
        ? {}
        : { organizationGrantContexts: normalizedGrantContexts }),
    },
  };
}

/** Throw a stable, framework-neutral validation error for an owner reference. */
export function assertValidArchitectureOwnerReference(input: unknown): ArchitectureOwnerReference {
  const result = validateArchitectureOwnerReference(input);
  if (!result.valid) throw new ArchitectureOwnershipValidationError(result.errors);
  return result.value;
}

/** Throw a stable, framework-neutral validation error for policy input. */
export function assertValidArchitecturePolicyInput(input: unknown): ArchitecturePolicyInput {
  const result = validateArchitecturePolicyInput(input);
  if (!result.valid) throw new ArchitectureOwnershipValidationError(result.errors);
  return result.value;
}

export const validateArchitectureOwnershipPolicyInput = validateArchitecturePolicyInput;
export const assertValidArchitectureOwnershipPolicyInput = assertValidArchitecturePolicyInput;
export const isArchitecturePolicyInput = (input: unknown): input is ArchitecturePolicyInput => validateArchitecturePolicyInput(input).valid;

function allowedOrganizationIdsForPolicy(input: ArchitecturePolicyInput): string[] {
  if (input.organizationVisibilityEnabled !== true) return [];
  const memberships = new Set((input.actor.organizationMemberships ?? []).map((membership) => membership.organizationId));
  const allowed = new Set<string>();
  for (const context of input.organizationGrantContexts ?? []) {
    if (
      context.accessLevel !== undefined && context.accessLevel !== "read"
      || context.organizationStatus !== "active"
      || context.grantPolicyOrganizationId !== context.organizationId
      || context.currentPolicyOrganizationId !== context.organizationId
      || !context.currentPolicyRevisionId
      || context.grantPolicyRevisionId !== context.currentPolicyRevisionId
      || !memberships.has(context.organizationId)
      || context.policy.sharing.organizationArchitectureSharingEnabled !== true
    ) {
      continue;
    }
    allowed.add(context.organizationId);
  }
  return [...allowed].sort((left, right) => left.localeCompare(right));
}

function accessWithOrganizationIds(
  access: Omit<ArchitectureAccess, "allowedOrganizationIds">,
  allowedOrganizationIds: readonly string[],
): ArchitectureAccess {
  return allowedOrganizationIds.length > 0
    ? { ...access, allowedOrganizationIds: [...allowedOrganizationIds] }
    : access;
}

/**
 * Evaluate all Phase 2A capabilities. The result depends only on the owner
 * reference and the supplied actor snapshot; input ordering cannot affect it.
 */
export function evaluateArchitecturePolicy(input: ArchitecturePolicyInput): ArchitecturePolicyDecision {
  const normalized = assertValidArchitecturePolicyInput(input);
  const { owner, actor } = normalized;
  const allowedOrganizationIds = allowedOrganizationIdsForPolicy(normalized);

  if (owner.type === "user") {
    const isOwner = actor.userId === owner.id;
    if (!isOwner && allowedOrganizationIds.length > 0) {
      return {
        owner: { ...owner },
        accessPolicyVersion: architectureAccessPolicyVersion,
        access: {
          canRead: true,
          canPreview: true,
          canAppendRevision: false,
          canManagePolicy: false,
          reason: "organization",
          allowedOrganizationIds: [...allowedOrganizationIds],
        },
      };
    }
    return {
      owner: { ...owner },
      accessPolicyVersion: architectureAccessPolicyVersion,
      access: accessWithOrganizationIds({
        canRead: isOwner,
        canPreview: isOwner,
        canAppendRevision: isOwner,
        canManagePolicy: isOwner,
        reason: isOwner ? "owner" : "not-owner",
      }, allowedOrganizationIds),
    };
  }

  const membership = (actor.teamMemberships ?? []).find((candidate) => candidate.teamId === owner.id);
  if (!membership) {
    if (allowedOrganizationIds.length > 0) {
      return {
        owner: { ...owner },
        accessPolicyVersion: architectureAccessPolicyVersion,
        access: {
          canRead: true,
          canPreview: true,
          canAppendRevision: false,
          canManagePolicy: false,
          reason: "organization",
          allowedOrganizationIds: [...allowedOrganizationIds],
        },
      };
    }
    return {
      owner: { ...owner },
      accessPolicyVersion: architectureAccessPolicyVersion,
      access: accessWithOrganizationIds({
        canRead: false,
        canPreview: false,
        canAppendRevision: false,
        canManagePolicy: false,
        reason: "not-team-member",
      }, allowedOrganizationIds),
    };
  }

  const isTeamOwner = membership.role === "owner";
  return {
    owner: { ...owner },
    accessPolicyVersion: architectureAccessPolicyVersion,
    access: accessWithOrganizationIds({
      canRead: true,
      canPreview: true,
      canAppendRevision: isTeamOwner,
      canManagePolicy: isTeamOwner,
      reason: isTeamOwner ? "team-owner" : "team-member",
    }, allowedOrganizationIds),
  };
}

export const evaluateArchitectureOwnershipPolicy = evaluateArchitecturePolicy;

function actionAllowed(access: ArchitectureAccess, action: ArchitectureAccessAction): boolean {
  switch (action) {
    case "read":
      return access.canRead;
    case "preview":
      return access.canPreview;
    case "create":
    case "append-revision":
      return access.canAppendRevision;
    case "manage-policy":
      return access.canManagePolicy;
  }
}

/** Evaluate one action while retaining the full policy's stable reason. */
export function evaluateArchitectureAccess(input: ArchitectureAccessEvaluationInput): ArchitectureAccessEvaluation {
  if (!isRecord(input) || !isArchitectureAccessAction(input.action)) {
    throw new ArchitectureOwnershipValidationError([{
      code: "ARCHITECTURE_ACCESS_ACTION_INVALID",
      message: "Architecture access action is unsupported.",
      path: "action",
    }]);
  }
  const { action, ...policyInput } = input;
  const normalized = assertValidArchitecturePolicyInput(policyInput);
  const policy = evaluateArchitecturePolicy(normalized);
  return {
    owner: policy.owner,
    accessPolicyVersion: policy.accessPolicyVersion,
    action,
    allowed: actionAllowed(policy.access, action),
    reason: policy.access.reason,
    ...(policy.access.allowedOrganizationIds
      ? { allowedOrganizationIds: [...policy.access.allowedOrganizationIds] }
      : {}),
  };
}

export const evaluateArchitectureOwnershipAccess = evaluateArchitectureAccess;

/** Check an action against an already-evaluated capability projection. */
export function isArchitectureAccessAllowed(access: ArchitectureAccess, action: ArchitectureAccessAction): boolean {
  if (!isArchitectureAccessAction(action)) return false;
  return actionAllowed(access, action);
}
