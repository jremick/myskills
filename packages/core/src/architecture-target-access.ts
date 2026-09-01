/** Pure target ownership and membership access policy evaluation. */

import {
  architectureTargetAccessActions,
  architectureTargetAccessPolicyVersion,
  architectureTargetAccessRoles,
  architectureTargetStatuses,
  type ArchitectureTargetAccess,
  type ArchitectureTargetAccessAction,
  type ArchitectureTargetAccessActor,
  type ArchitectureTargetAccessEvaluation,
  type ArchitectureTargetAccessEvaluationInput,
  type ArchitectureTargetAccessPolicyDecision,
  type ArchitectureTargetAccessPolicyInput,
  type ArchitectureTargetAccessReason,
  type ArchitectureTargetAccessRole,
  type ArchitectureTargetOrganizationMembership,
  type ArchitectureTargetTeamMembership,
  type ArchitectureTargetValidationIssue,
  type ArchitectureTargetValidationResult,
  ArchitectureTargetValidationError,
} from "./architecture-target-contracts.js";
import {
  checkSensitiveKeys,
  checkUnknownKeys,
  isOneOf,
  isRecord,
  issue,
  validateOwner,
  validIdentifier,
} from "./architecture-target-validation.js";

function isArchitectureTargetAccessAction(value: unknown): value is ArchitectureTargetAccessAction {
  return isOneOf(value, architectureTargetAccessActions);
}

function isArchitectureTargetAccessRole(value: unknown): value is ArchitectureTargetAccessRole {
  return isOneOf(value, architectureTargetAccessRoles);
}

/** Validate and normalize the already-resolved actor snapshot for target access. */
export function validateArchitectureTargetAccessPolicyInput(input: unknown): ArchitectureTargetValidationResult<ArchitectureTargetAccessPolicyInput> {
  const errors: ArchitectureTargetValidationIssue[] = [];
  if (!isRecord(input)) return { valid: false, errors: [{ code: "ARCHITECTURE_TARGET_ACCESS_POLICY_INVALID", message: "Target access policy input must be an object." }] };
  checkSensitiveKeys(input, "targetAccess", errors);
  checkUnknownKeys(input, ["owner", "status", "actor"], "targetAccess", errors);
  const owner = validateOwner(input.owner, "targetAccess.owner", errors);
  if (!isOneOf(input.status, architectureTargetStatuses)) issue(errors, "ARCHITECTURE_TARGET_STATUS_INVALID", "Target status is invalid.", "targetAccess.status");

  let actor: ArchitectureTargetAccessActor | undefined;
  if (!isRecord(input.actor)) {
    issue(errors, "ARCHITECTURE_TARGET_ACCESS_ACTOR_INVALID", "Target access actor must be an object.", "targetAccess.actor");
  } else {
    checkUnknownKeys(input.actor, ["userId", "teamMemberships", "organizationMemberships"], "targetAccess.actor", errors);
    if (!validIdentifier(input.actor.userId)) issue(errors, "ARCHITECTURE_TARGET_ACCESS_USER_ID_INVALID", "Target access actor userId must be a bounded identifier.", "targetAccess.actor.userId");

    const teamMemberships: ArchitectureTargetTeamMembership[] = [];
    const rawTeams = input.actor.teamMemberships;
    if (rawTeams !== undefined && !Array.isArray(rawTeams)) issue(errors, "ARCHITECTURE_TARGET_ACCESS_TEAM_MEMBERSHIPS_INVALID", "Target access teamMemberships must be an array.", "targetAccess.actor.teamMemberships");
    const seenTeamIds = new Set<string>();
    for (const [index, value] of (Array.isArray(rawTeams) ? rawTeams : []).entries()) {
      const path = `targetAccess.actor.teamMemberships[${index}]`;
      if (!isRecord(value)) {
        issue(errors, "ARCHITECTURE_TARGET_ACCESS_TEAM_MEMBERSHIP_INVALID", "Target access team membership must be an object.", path);
        continue;
      }
      checkUnknownKeys(value, ["teamId", "role"], path, errors);
      if (!validIdentifier(value.teamId)) issue(errors, "ARCHITECTURE_TARGET_ACCESS_TEAM_ID_INVALID", "Target access teamId must be a bounded identifier.", `${path}.teamId`);
      if (value.role !== "owner" && value.role !== "member") issue(errors, "ARCHITECTURE_TARGET_ACCESS_TEAM_ROLE_INVALID", "Target access team role must be owner or member.", `${path}.role`);
      if (validIdentifier(value.teamId) && seenTeamIds.has(value.teamId)) issue(errors, "ARCHITECTURE_TARGET_ACCESS_TEAM_MEMBERSHIP_DUPLICATE", "Target access team memberships must contain one entry per team.", `${path}.teamId`);
      if (validIdentifier(value.teamId)) seenTeamIds.add(value.teamId);
      if (validIdentifier(value.teamId) && (value.role === "owner" || value.role === "member")) teamMemberships.push({ teamId: value.teamId, role: value.role });
    }
    teamMemberships.sort((left, right) => left.teamId.localeCompare(right.teamId));

    const organizationMemberships: ArchitectureTargetOrganizationMembership[] = [];
    const rawOrganizations = input.actor.organizationMemberships;
    if (rawOrganizations !== undefined && !Array.isArray(rawOrganizations)) issue(errors, "ARCHITECTURE_TARGET_ACCESS_ORGANIZATION_MEMBERSHIPS_INVALID", "Target access organizationMemberships must be an array.", "targetAccess.actor.organizationMemberships");
    const seenOrganizationIds = new Set<string>();
    for (const [index, value] of (Array.isArray(rawOrganizations) ? rawOrganizations : []).entries()) {
      const path = `targetAccess.actor.organizationMemberships[${index}]`;
      if (!isRecord(value)) {
        issue(errors, "ARCHITECTURE_TARGET_ACCESS_ORGANIZATION_MEMBERSHIP_INVALID", "Target access organization membership must be an object.", path);
        continue;
      }
      checkUnknownKeys(value, ["organizationId", "role"], path, errors);
      if (!validIdentifier(value.organizationId)) issue(errors, "ARCHITECTURE_TARGET_ACCESS_ORGANIZATION_ID_INVALID", "Target access organizationId must be a bounded identifier.", `${path}.organizationId`);
      if (!isArchitectureTargetAccessRole(value.role)) issue(errors, "ARCHITECTURE_TARGET_ACCESS_ORGANIZATION_ROLE_INVALID", "Target access organization role must be owner, admin, or member.", `${path}.role`);
      if (validIdentifier(value.organizationId) && seenOrganizationIds.has(value.organizationId)) issue(errors, "ARCHITECTURE_TARGET_ACCESS_ORGANIZATION_MEMBERSHIP_DUPLICATE", "Target access organization memberships must contain one entry per organization.", `${path}.organizationId`);
      if (validIdentifier(value.organizationId)) seenOrganizationIds.add(value.organizationId);
      if (validIdentifier(value.organizationId) && isArchitectureTargetAccessRole(value.role)) organizationMemberships.push({ organizationId: value.organizationId, role: value.role });
    }
    organizationMemberships.sort((left, right) => left.organizationId.localeCompare(right.organizationId));
    actor = {
      userId: typeof input.actor.userId === "string" ? input.actor.userId : "",
      teamMemberships,
      organizationMemberships,
    };
  }

  if (errors.length > 0 || !owner || !isOneOf(input.status, architectureTargetStatuses) || !actor || !validIdentifier(actor.userId)) return { valid: false, errors };
  return {
    valid: true,
    value: {
      owner,
      status: input.status,
      actor,
    },
  };
}

export function assertValidArchitectureTargetAccessPolicyInput(input: unknown): ArchitectureTargetAccessPolicyInput {
  const result = validateArchitectureTargetAccessPolicyInput(input);
  if (!result.valid) throw new ArchitectureTargetValidationError(result.errors);
  return result.value;
}

function emptyTargetAccess(reason: ArchitectureTargetAccessReason): ArchitectureTargetAccess {
  return {
    canList: false,
    canRead: false,
    canRegister: false,
    canObserve: false,
    canHealth: false,
    canRevoke: false,
    reason,
  };
}

function revokedTargetAccess(access: ArchitectureTargetAccess): ArchitectureTargetAccess {
  return {
    ...access,
    canRegister: false,
    canObserve: false,
    canHealth: false,
    canRevoke: false,
    reason: "target-revoked",
  };
}

/** Evaluate target capabilities from current membership snapshots only. */
export function evaluateArchitectureTargetAccessPolicy(input: ArchitectureTargetAccessPolicyInput): ArchitectureTargetAccessPolicyDecision {
  const normalized = assertValidArchitectureTargetAccessPolicyInput(input);
  const { owner, status, actor } = normalized;
  let access: ArchitectureTargetAccess;

  if (owner.type === "user") {
    const isOwner = actor.userId === owner.id;
    access = isOwner
      ? { canList: true, canRead: true, canRegister: true, canObserve: true, canHealth: true, canRevoke: true, reason: "owner" }
      : emptyTargetAccess("not-owner");
  } else if (owner.type === "team") {
    const membership = actor.teamMemberships?.find((candidate) => candidate.teamId === owner.id);
    if (!membership) access = emptyTargetAccess("not-member");
    else if (membership.role === "owner") access = { canList: true, canRead: true, canRegister: true, canObserve: true, canHealth: true, canRevoke: true, reason: "team-owner" };
    else access = { canList: true, canRead: true, canRegister: false, canObserve: false, canHealth: false, canRevoke: false, reason: "team-member" };
  } else {
    const membership = actor.organizationMemberships?.find((candidate) => candidate.organizationId === owner.id);
    if (!membership) access = emptyTargetAccess("not-member");
    else if (membership.role === "owner") access = { canList: true, canRead: true, canRegister: true, canObserve: true, canHealth: true, canRevoke: true, reason: "organization-owner" };
    else if (membership.role === "admin") access = { canList: true, canRead: true, canRegister: true, canObserve: true, canHealth: true, canRevoke: true, reason: "organization-admin" };
    else access = { canList: true, canRead: true, canRegister: false, canObserve: false, canHealth: false, canRevoke: false, reason: "organization-member" };
  }

  return {
    owner: { ...owner },
    targetStatus: status,
    accessPolicyVersion: architectureTargetAccessPolicyVersion,
    access: status === "revoked" && access.canRead ? revokedTargetAccess(access) : access,
  };
}

export const evaluateArchitectureTargetPolicy = evaluateArchitectureTargetAccessPolicy;

function targetActionAllowed(access: ArchitectureTargetAccess, action: ArchitectureTargetAccessAction): boolean {
  switch (action) {
    case "list": return access.canList;
    case "read": return access.canRead;
    case "register": return access.canRegister;
    case "observe": return access.canObserve;
    case "health": return access.canHealth;
    case "revoke": return access.canRevoke;
  }
}

/** Evaluate one target action and retain the stable policy reason. */
export function evaluateArchitectureTargetAccess(input: ArchitectureTargetAccessEvaluationInput): ArchitectureTargetAccessEvaluation {
  if (!isRecord(input) || !isArchitectureTargetAccessAction(input.action)) {
    throw new ArchitectureTargetValidationError([{
      code: "ARCHITECTURE_TARGET_ACCESS_ACTION_INVALID",
      message: "Target access action is unsupported.",
      path: "action",
    }]);
  }
  const { action, ...policyInput } = input;
  const policy = evaluateArchitectureTargetAccessPolicy(policyInput);
  return {
    owner: policy.owner,
    targetStatus: policy.targetStatus,
    accessPolicyVersion: policy.accessPolicyVersion,
    action,
    allowed: targetActionAllowed(policy.access, action),
    reason: policy.access.reason,
  };
}

export const evaluateArchitectureTargetOwnershipAccess = evaluateArchitectureTargetAccess;

/** Check a target action against an already-evaluated capability projection. */
export function isArchitectureTargetAccessAllowed(access: ArchitectureTargetAccess, action: ArchitectureTargetAccessAction): boolean {
  if (!isArchitectureTargetAccessAction(action)) return false;
  return targetActionAllowed(access, action);
}
