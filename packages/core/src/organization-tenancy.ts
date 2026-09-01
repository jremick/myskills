/**
 * Framework-neutral organization tenancy and policy contracts.
 *
 * Organizations are an explicit policy boundary. This module intentionally
 * does not know about a database, users, invitations, or a request framework.
 * Callers provide an already-resolved snapshot of the actor's active
 * memberships and the organization's current policy.
 */

import { canonicalizeJson, sha256Hex } from "./architecture.js";

export const organizationPolicySchemaVersion = 1 as const;
export type OrganizationPolicySchemaVersion = typeof organizationPolicySchemaVersion;

export const organizationStatuses = ["provisioning", "active", "suspended", "archived"] as const;
export type OrganizationStatus = (typeof organizationStatuses)[number];
export const organizationLifecycleStatuses = organizationStatuses;

export const organizationMembershipRoles = ["owner", "admin", "member"] as const;
export type OrganizationMembershipRole = (typeof organizationMembershipRoles)[number];
export const organizationRoles = organizationMembershipRoles;
export type OrganizationRole = OrganizationMembershipRole;

/** The policy actions are deliberately narrower than an application route list. */
export const organizationAccessActions = ["read", "share", "admin", "policy"] as const;
export type OrganizationAccessAction = (typeof organizationAccessActions)[number];
export const organizationPolicyActions = organizationAccessActions;

export const organizationResourceKinds = ["skill", "architecture"] as const;
export type OrganizationResourceKind = (typeof organizationResourceKinds)[number];

export const organizationAccessReasons = [
  "owner",
  "admin",
  "member",
  "not-member",
  "organization-inactive",
  "policy-disabled",
  "member-sharing-disabled",
] as const;
export type OrganizationAccessReason = (typeof organizationAccessReasons)[number];

export interface OrganizationSharingPolicyV1 {
  readonly organizationSkillSharingEnabled: boolean;
  readonly organizationArchitectureSharingEnabled: boolean;
  readonly membersCanShareOwnedSkillsToOrganization: boolean;
  readonly teamOwnersCanShareArchitecturesToParentOrganization: boolean;
}

export interface OrganizationTeamsPolicyV1 {
  readonly membersCanCreateTeams: boolean;
  readonly requireOrganizationMembershipForTeamMembers: boolean;
  readonly allowStandaloneTeamAdoption: boolean;
}

export interface OrganizationLimitsPolicyV1 {
  readonly teamsPerOrganization: number;
  readonly membersPerOrganization: number;
  readonly organizationGrantsPerSkill: number;
  readonly organizationGrantsPerArchitecture: number;
}

/** Canonical organization policy stored in an immutable policy revision. */
export interface OrganizationPolicyV1 {
  readonly schemaVersion: OrganizationPolicySchemaVersion;
  readonly sharing: OrganizationSharingPolicyV1;
  readonly teams: OrganizationTeamsPolicyV1;
  readonly limits: OrganizationLimitsPolicyV1;
}

export type OrganizationPolicyV1Input = {
  schemaVersion?: unknown;
  sharing?: unknown;
  teams?: unknown;
  limits?: unknown;
};

const defaultOrganizationPolicy = {
  schemaVersion: organizationPolicySchemaVersion,
  sharing: {
    organizationSkillSharingEnabled: true,
    organizationArchitectureSharingEnabled: true,
    membersCanShareOwnedSkillsToOrganization: false,
    teamOwnersCanShareArchitecturesToParentOrganization: false,
  },
  teams: {
    membersCanCreateTeams: false,
    requireOrganizationMembershipForTeamMembers: true,
    allowStandaloneTeamAdoption: true,
  },
  limits: {
    teamsPerOrganization: 100,
    membersPerOrganization: 1000,
    organizationGrantsPerSkill: 25,
    organizationGrantsPerArchitecture: 25,
  },
} as const satisfies OrganizationPolicyV1;

/** Deeply immutable defaults. Normalization returns a separate clone. */
export const defaultOrganizationPolicyV1: OrganizationPolicyV1 = Object.freeze({
  schemaVersion: defaultOrganizationPolicy.schemaVersion,
  sharing: Object.freeze({ ...defaultOrganizationPolicy.sharing }),
  teams: Object.freeze({ ...defaultOrganizationPolicy.teams }),
  limits: Object.freeze({ ...defaultOrganizationPolicy.limits }),
});
export const organizationPolicyDefaults = defaultOrganizationPolicyV1;

/** An active membership is the only membership form accepted by evaluators. */
export interface ActiveOrganizationMembershipInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: OrganizationMembershipRole;
}
export type OrganizationMembershipInput = ActiveOrganizationMembershipInput;

export interface OrganizationPolicyActorInput {
  readonly userId: string;
  readonly memberships?: readonly ActiveOrganizationMembershipInput[];
}
export type OrganizationPolicyActor = OrganizationPolicyActorInput;

export interface OrganizationEvaluationOrganizationInput {
  readonly id: string;
  readonly status: OrganizationStatus;
}

/**
 * The flat form is convenient for stores and route handlers. Memberships may
 * contain multiple organizations; the evaluator selects only the requested
 * organization, so membership in one organization never implies another.
 */
export interface OrganizationPolicyInput {
  readonly organizationId: string;
  readonly organizationStatus: OrganizationStatus;
  readonly policy: OrganizationPolicyV1;
  readonly actor: OrganizationPolicyActorInput;
  readonly resource?: OrganizationResourceKind;
}

/** A nested alias keeps the organization boundary discoverable to callers. */
export interface OrganizationEvaluationInput {
  readonly organization: OrganizationEvaluationOrganizationInput;
  readonly policy: OrganizationPolicyV1;
  readonly actor: OrganizationPolicyActorInput;
  readonly resource?: OrganizationResourceKind;
}

export interface OrganizationAccess {
  readonly canRead: boolean;
  readonly canShare: boolean;
  readonly canAdmin: boolean;
  readonly canManagePolicy: boolean;
  readonly reason: OrganizationAccessReason;
  readonly membershipRole?: OrganizationMembershipRole;
}

export interface OrganizationPolicyDecision {
  readonly organizationId: string;
  readonly organizationStatus: OrganizationStatus;
  readonly policySchemaVersion: OrganizationPolicySchemaVersion;
  readonly policySha256: string;
  readonly access: OrganizationAccess;
}

export interface OrganizationAccessEvaluationInput extends OrganizationPolicyInput {
  readonly action: OrganizationAccessAction;
}

export interface OrganizationAccessEvaluation {
  readonly organizationId: string;
  readonly organizationStatus: OrganizationStatus;
  readonly policySchemaVersion: OrganizationPolicySchemaVersion;
  readonly policySha256: string;
  readonly action: OrganizationAccessAction;
  readonly resource?: OrganizationResourceKind;
  readonly allowed: boolean;
  readonly reason: OrganizationAccessReason;
}

/**
 * This is the append input, not a database row. IDs, timestamps, and actor
 * audit fields belong to the persistence boundary and are not part of the
 * policy digest. The readonly shape makes revision contents append-only at
 * the shared contract boundary.
 */
export interface OrganizationPolicyRevisionInput {
  readonly organizationId: string;
  readonly policy: OrganizationPolicyV1;
  readonly reason?: string;
}

export interface NormalizedOrganizationPolicyRevisionInput {
  readonly organizationId: string;
  readonly policy: OrganizationPolicyV1;
  readonly policySha256: string;
  readonly reason: string;
}

export interface OrganizationPolicyRevision {
  readonly id: string;
  readonly organizationId: string;
  readonly revisionNumber: number;
  readonly policy: OrganizationPolicyV1;
  readonly policySha256: string;
  readonly reason: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

export type OrganizationPolicyValidationCode =
  | "ORGANIZATION_POLICY_INVALID_OBJECT"
  | "ORGANIZATION_POLICY_UNKNOWN_FIELD"
  | "ORGANIZATION_POLICY_SCHEMA_VERSION_INVALID"
  | "ORGANIZATION_POLICY_SECTION_INVALID"
  | "ORGANIZATION_POLICY_FLAG_INVALID"
  | "ORGANIZATION_POLICY_LIMIT_INVALID"
  | "ORGANIZATION_POLICY_LIMIT_OUT_OF_RANGE"
  | "ORGANIZATION_STATUS_INVALID"
  | "ORGANIZATION_ID_INVALID"
  | "ORGANIZATION_USER_ID_INVALID"
  | "ORGANIZATION_ACTOR_INVALID"
  | "ORGANIZATION_MEMBERSHIPS_INVALID"
  | "ORGANIZATION_MEMBERSHIP_INVALID"
  | "ORGANIZATION_MEMBERSHIP_DUPLICATE"
  | "ORGANIZATION_MEMBERSHIP_ROLE_INVALID"
  | "ORGANIZATION_ACTION_INVALID"
  | "ORGANIZATION_RESOURCE_INVALID"
  | "ORGANIZATION_REVISION_INVALID"
  | "ORGANIZATION_REVISION_REASON_INVALID";

export interface OrganizationPolicyValidationIssue {
  readonly code: OrganizationPolicyValidationCode;
  readonly message: string;
  readonly path?: string;
}

export type OrganizationPolicyValidationResult =
  | { readonly valid: true; readonly value: OrganizationPolicyV1 }
  | { readonly valid: false; readonly errors: OrganizationPolicyValidationIssue[] };

export type OrganizationPolicyInputValidationResult =
  | { readonly valid: true; readonly value: OrganizationPolicyInput }
  | { readonly valid: false; readonly errors: OrganizationPolicyValidationIssue[] };

export type OrganizationPolicyRevisionValidationResult =
  | { readonly valid: true; readonly value: NormalizedOrganizationPolicyRevisionInput }
  | { readonly valid: false; readonly errors: OrganizationPolicyValidationIssue[] };

export class OrganizationTenancyValidationError extends Error {
  public readonly code = "ORGANIZATION_TENANCY_VALIDATION_FAILED";

  constructor(public readonly errors: readonly OrganizationPolicyValidationIssue[]) {
    super(errors.map((error) => `${error.code}: ${error.message}`).join("; ") || "Organization tenancy input is invalid.");
    this.name = "OrganizationTenancyValidationError";
  }
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const maxPolicyLimit = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key)).sort();
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

function isOrganizationStatus(value: unknown): value is OrganizationStatus {
  return typeof value === "string" && (organizationStatuses as readonly string[]).includes(value);
}

function isOrganizationRole(value: unknown): value is OrganizationMembershipRole {
  return typeof value === "string" && (organizationMembershipRoles as readonly string[]).includes(value);
}

function isOrganizationAction(value: unknown): value is OrganizationAccessAction {
  return typeof value === "string" && (organizationAccessActions as readonly string[]).includes(value);
}

function isOrganizationResource(value: unknown): value is OrganizationResourceKind {
  return typeof value === "string" && (organizationResourceKinds as readonly string[]).includes(value);
}

function issue(
  code: OrganizationPolicyValidationCode,
  message: string,
  path?: string,
): OrganizationPolicyValidationIssue {
  return { code, message, ...(path ? { path } : {}) };
}

function clonePolicy(policy: OrganizationPolicyV1): OrganizationPolicyV1 {
  return {
    schemaVersion: policy.schemaVersion,
    sharing: { ...policy.sharing },
    teams: { ...policy.teams },
    limits: { ...policy.limits },
  };
}

function normalizedPolicyResult(
  errors: OrganizationPolicyValidationIssue[],
  value: OrganizationPolicyV1,
): OrganizationPolicyValidationResult {
  return errors.length > 0 ? { valid: false, errors } : { valid: true, value };
}

/** Validate and normalize the policy, applying only the documented defaults. */
export function validateOrganizationPolicyV1(input: unknown): OrganizationPolicyValidationResult {
  if (!isRecord(input)) {
    return { valid: false, errors: [issue("ORGANIZATION_POLICY_INVALID_OBJECT", "Organization policy must be an object.")] };
  }

  const errors: OrganizationPolicyValidationIssue[] = [];
  for (const key of unknownKeys(input, ["schemaVersion", "sharing", "teams", "limits"])) {
    errors.push(issue(
      "ORGANIZATION_POLICY_UNKNOWN_FIELD",
      `Organization policy field '${key}' is not accepted.`,
      key,
    ));
  }

  const schemaVersion = input.schemaVersion === undefined ? organizationPolicySchemaVersion : input.schemaVersion;
  if (schemaVersion !== organizationPolicySchemaVersion) {
    errors.push(issue(
      "ORGANIZATION_POLICY_SCHEMA_VERSION_INVALID",
      `Organization policy schemaVersion must be ${organizationPolicySchemaVersion}.`,
      "schemaVersion",
    ));
  }

  const sections: Array<{
    name: "sharing" | "teams" | "limits";
    defaults: Record<string, boolean | number>;
    kind: "flags" | "limits";
  }> = [
    { name: "sharing", defaults: defaultOrganizationPolicy.sharing, kind: "flags" },
    { name: "teams", defaults: defaultOrganizationPolicy.teams, kind: "flags" },
    { name: "limits", defaults: defaultOrganizationPolicy.limits, kind: "limits" },
  ];

  const normalizedSections: Record<string, Record<string, boolean | number>> = {};
  for (const section of sections) {
    const rawSection = input[section.name];
    if (rawSection !== undefined && !isRecord(rawSection)) {
      errors.push(issue(
        "ORGANIZATION_POLICY_SECTION_INVALID",
        `Organization policy ${section.name} must be an object.`,
        section.name,
      ));
    }
    const record = isRecord(rawSection) ? rawSection : {};
    for (const key of unknownKeys(record, Object.keys(section.defaults))) {
      errors.push(issue(
        "ORGANIZATION_POLICY_UNKNOWN_FIELD",
        `Organization policy field '${key}' is not accepted in ${section.name}.`,
        `${section.name}.${key}`,
      ));
    }

    const normalized: Record<string, boolean | number> = {};
    for (const [key, defaultValue] of Object.entries(section.defaults)) {
      const value = record[key] === undefined ? defaultValue : record[key];
      if (section.kind === "flags") {
        if (typeof value !== "boolean") {
          errors.push(issue(
            "ORGANIZATION_POLICY_FLAG_INVALID",
            `Organization policy ${section.name}.${key} must be boolean.`,
            `${section.name}.${key}`,
          ));
          continue;
        }
        normalized[key] = value;
      } else {
        if (typeof value !== "number" || !Number.isInteger(value)) {
          errors.push(issue(
            "ORGANIZATION_POLICY_LIMIT_INVALID",
            `Organization policy limits.${key} must be an integer.`,
            `${section.name}.${key}`,
          ));
          continue;
        }
        if (value < 0 || value > maxPolicyLimit) {
          errors.push(issue(
            "ORGANIZATION_POLICY_LIMIT_OUT_OF_RANGE",
            `Organization policy limits.${key} must be between 0 and ${maxPolicyLimit}.`,
            `${section.name}.${key}`,
          ));
          continue;
        }
        normalized[key] = value;
      }
    }
    normalizedSections[section.name] = normalized;
  }

  const value: OrganizationPolicyV1 = {
    schemaVersion: organizationPolicySchemaVersion,
    sharing: normalizedSections.sharing as unknown as OrganizationSharingPolicyV1,
    teams: normalizedSections.teams as unknown as OrganizationTeamsPolicyV1,
    limits: normalizedSections.limits as unknown as OrganizationLimitsPolicyV1,
  };
  return normalizedPolicyResult(errors, value);
}

/** Return a normalized, detached policy or throw a stable validation error. */
export function normalizeOrganizationPolicyV1(input: unknown): OrganizationPolicyV1 {
  const result = validateOrganizationPolicyV1(input);
  if (!result.valid) throw new OrganizationTenancyValidationError(result.errors);
  return clonePolicy(result.value);
}

export function assertValidOrganizationPolicyV1(input: unknown): OrganizationPolicyV1 {
  return normalizeOrganizationPolicyV1(input);
}

export const validateOrganizationPolicy = validateOrganizationPolicyV1;
export const normalizeOrganizationPolicy = normalizeOrganizationPolicyV1;
export const assertValidOrganizationPolicy = assertValidOrganizationPolicyV1;

/** Canonical policy JSON uses the same key sorting convention as architectures. */
export function canonicalOrganizationPolicyJson(input: unknown): string {
  return canonicalizeJson(normalizeOrganizationPolicyV1(input));
}

/** Lowercase SHA-256 digest of the normalized policy only. */
export function organizationPolicyDigest(input: unknown): string {
  return sha256Hex(canonicalOrganizationPolicyJson(input));
}

export const digestOrganizationPolicy = organizationPolicyDigest;
export const organizationPolicySha256 = organizationPolicyDigest;
export const computeOrganizationPolicyDigest = organizationPolicyDigest;

function normalizeMemberships(
  input: unknown,
  errors: OrganizationPolicyValidationIssue[],
): ActiveOrganizationMembershipInput[] {
  if (input !== undefined && !Array.isArray(input)) {
    errors.push(issue(
      "ORGANIZATION_MEMBERSHIPS_INVALID",
      "Organization policy actor memberships must be an array.",
      "actor.memberships",
    ));
    return [];
  }
  const normalized: ActiveOrganizationMembershipInput[] = [];
  const seen = new Set<string>();
  for (const [index, rawMembership] of (input ?? []).entries()) {
    const path = `actor.memberships[${index}]`;
    if (!isRecord(rawMembership)) {
      errors.push(issue("ORGANIZATION_MEMBERSHIP_INVALID", "Organization membership must be an object.", path));
      continue;
    }
    for (const key of unknownKeys(rawMembership, ["organizationId", "userId", "role"])) {
      errors.push(issue(
        "ORGANIZATION_POLICY_UNKNOWN_FIELD",
        `Organization membership field '${key}' is not accepted.`,
        `${path}.${key}`,
      ));
    }
    if (!validIdentifier(rawMembership.organizationId)) {
      errors.push(issue("ORGANIZATION_ID_INVALID", "Organization membership organizationId must be a bounded identifier.", `${path}.organizationId`));
    }
    if (!validIdentifier(rawMembership.userId)) {
      errors.push(issue("ORGANIZATION_USER_ID_INVALID", "Organization membership userId must be a bounded identifier.", `${path}.userId`));
    }
    if (!isOrganizationRole(rawMembership.role)) {
      errors.push(issue(
        "ORGANIZATION_MEMBERSHIP_ROLE_INVALID",
        "Organization membership role must be 'owner', 'admin', or 'member'.",
        `${path}.role`,
      ));
    }
    const organizationId = rawMembership.organizationId;
    const userId = rawMembership.userId;
    const key = typeof organizationId === "string" && typeof userId === "string"
      ? `${organizationId}\u0000${userId}`
      : "";
    if (key && seen.has(key)) {
      errors.push(issue(
        "ORGANIZATION_MEMBERSHIP_DUPLICATE",
        "Organization actor memberships must contain one active entry per organization and user.",
        `${path}.userId`,
      ));
    }
    if (key) seen.add(key);
    if (validIdentifier(organizationId) && validIdentifier(userId) && isOrganizationRole(rawMembership.role)) {
      normalized.push({ organizationId, userId, role: rawMembership.role });
    }
  }
  normalized.sort((left, right) => (
    `${left.organizationId}\u0000${left.userId}`.localeCompare(`${right.organizationId}\u0000${right.userId}`)
  ));
  return normalized;
}

function normalizePolicyActor(input: unknown, errors: OrganizationPolicyValidationIssue[]): OrganizationPolicyActorInput {
  if (!isRecord(input)) {
    errors.push(issue("ORGANIZATION_ACTOR_INVALID", "Organization policy actor must be an object.", "actor"));
    return { userId: "", memberships: [] };
  }
  for (const key of unknownKeys(input, ["userId", "memberships"])) {
    errors.push(issue(
      "ORGANIZATION_POLICY_UNKNOWN_FIELD",
      `Organization policy actor field '${key}' is not accepted.`,
      `actor.${key}`,
    ));
  }
  if (!validIdentifier(input.userId)) {
    errors.push(issue("ORGANIZATION_USER_ID_INVALID", "Organization policy actor userId must be a bounded identifier.", "actor.userId"));
  }
  const memberships = normalizeMemberships(input.memberships, errors);
  return {
    userId: typeof input.userId === "string" ? input.userId : "",
    memberships,
  };
}

function normalizeOrganizationPolicyInput(input: unknown): OrganizationPolicyInputValidationResult {
  if (!isRecord(input)) {
    return { valid: false, errors: [issue("ORGANIZATION_POLICY_INVALID_OBJECT", "Organization policy input must be an object.")] };
  }
  const errors: OrganizationPolicyValidationIssue[] = [];
  for (const key of unknownKeys(input, ["organizationId", "organizationStatus", "policy", "actor", "resource"])) {
    errors.push(issue("ORGANIZATION_POLICY_UNKNOWN_FIELD", `Organization policy input field '${key}' is not accepted.`, key));
  }
  if (!validIdentifier(input.organizationId)) {
    errors.push(issue("ORGANIZATION_ID_INVALID", "Organization policy organizationId must be a bounded identifier.", "organizationId"));
  }
  if (!isOrganizationStatus(input.organizationStatus)) {
    errors.push(issue("ORGANIZATION_STATUS_INVALID", "Organization policy organizationStatus is unsupported.", "organizationStatus"));
  }
  if (input.resource !== undefined && !isOrganizationResource(input.resource)) {
    errors.push(issue("ORGANIZATION_RESOURCE_INVALID", "Organization policy resource must be 'skill' or 'architecture'.", "resource"));
  }
  const policyResult = validateOrganizationPolicyV1(input.policy);
  if (!policyResult.valid) errors.push(...policyResult.errors.map((error) => ({ ...error, path: error.path ? `policy.${error.path}` : "policy" })));
  const actor = normalizePolicyActor(input.actor, errors);
  if (errors.length > 0 || !policyResult.valid || !isOrganizationStatus(input.organizationStatus)) {
    return { valid: false, errors };
  }
  return {
    valid: true,
    value: {
      organizationId: input.organizationId as string,
      organizationStatus: input.organizationStatus,
      policy: clonePolicy(policyResult.value),
      actor,
      ...(input.resource !== undefined ? { resource: input.resource as OrganizationResourceKind } : {}),
    },
  };
}

/** Validate and normalize an actor/org/policy snapshot for all evaluators. */
export function validateOrganizationPolicyInput(input: unknown): OrganizationPolicyInputValidationResult {
  return normalizeOrganizationPolicyInput(input);
}

export function assertValidOrganizationPolicyInput(input: unknown): OrganizationPolicyInput {
  const result = validateOrganizationPolicyInput(input);
  if (!result.valid) throw new OrganizationTenancyValidationError(result.errors);
  return result.value;
}

export const isOrganizationPolicyInput = (input: unknown): input is OrganizationPolicyInput => validateOrganizationPolicyInput(input).valid;

function membershipForOrganization(input: OrganizationPolicyInput): ActiveOrganizationMembershipInput | undefined {
  return input.actor.memberships?.find((membership) => (
    membership.organizationId === input.organizationId && membership.userId === input.actor.userId
  ));
}

function resourceSharingEnabled(policy: OrganizationPolicyV1, resource: OrganizationResourceKind | undefined): boolean {
  if (resource === "skill") return policy.sharing.organizationSkillSharingEnabled;
  if (resource === "architecture") return policy.sharing.organizationArchitectureSharingEnabled;
  return policy.sharing.organizationSkillSharingEnabled || policy.sharing.organizationArchitectureSharingEnabled;
}

/**
 * Evaluate all organization capabilities. A member in another organization
 * cannot satisfy this decision, and suspended/archived organizations fail
 * closed. Provisioning organizations permit only owner policy setup.
 */
export function evaluateOrganizationPolicy(input: OrganizationPolicyInput): OrganizationPolicyDecision {
  const normalized = assertValidOrganizationPolicyInput(input);
  const policySha256 = organizationPolicyDigest(normalized.policy);
  const membership = membershipForOrganization(normalized);
  const isActive = normalized.organizationStatus === "active";
  const isPolicySetup = normalized.organizationStatus === "provisioning";
  const role = membership?.role;
  const relationshipReason: OrganizationAccessReason = role ?? "not-member";

  const canRead = Boolean(isActive && membership && resourceSharingEnabled(normalized.policy, normalized.resource));
  const canShare = Boolean(
    isActive
      && membership
      && resourceSharingEnabled(normalized.policy, normalized.resource)
      && (role === "owner"
        || role === "admin"
        || (role === "member"
          && normalized.resource === "skill"
          && normalized.policy.sharing.membersCanShareOwnedSkillsToOrganization)),
  );
  const canAdmin = Boolean(isActive && (role === "owner" || role === "admin"));
  const canManagePolicy = Boolean((isActive || isPolicySetup) && role === "owner");

  let reason: OrganizationAccessReason = relationshipReason;
  if (!membership) reason = "not-member";
  else if (!isActive && !canManagePolicy) reason = "organization-inactive";
  else if (isActive && !resourceSharingEnabled(normalized.policy, normalized.resource) && !canAdmin && !canManagePolicy) reason = "policy-disabled";
  else if (isActive && role === "member" && normalized.resource === "skill" && !normalized.policy.sharing.membersCanShareOwnedSkillsToOrganization && !canRead) reason = "member-sharing-disabled";

  return {
    organizationId: normalized.organizationId,
    organizationStatus: normalized.organizationStatus,
    policySchemaVersion: organizationPolicySchemaVersion,
    policySha256,
    access: {
      canRead,
      canShare,
      canAdmin,
      canManagePolicy,
      reason,
      ...(role ? { membershipRole: role } : {}),
    },
  };
}

function actionAllowed(access: OrganizationAccess, action: OrganizationAccessAction): boolean {
  switch (action) {
    case "read": return access.canRead;
    case "share": return access.canShare;
    case "admin": return access.canAdmin;
    case "policy": return access.canManagePolicy;
  }
}

/** Evaluate one organization action with the complete stable policy reason. */
export function evaluateOrganizationAccess(input: OrganizationAccessEvaluationInput): OrganizationAccessEvaluation {
  if (!isRecord(input) || !isOrganizationAction(input.action)) {
    throw new OrganizationTenancyValidationError([
      issue("ORGANIZATION_ACTION_INVALID", "Organization access action is unsupported.", "action"),
    ]);
  }
  const { action, ...policyInput } = input;
  const normalized = assertValidOrganizationPolicyInput(policyInput);
  const policy = evaluateOrganizationPolicy(normalized);
  return {
    organizationId: policy.organizationId,
    organizationStatus: policy.organizationStatus,
    policySchemaVersion: policy.policySchemaVersion,
    policySha256: policy.policySha256,
    action,
    ...(normalized.resource ? { resource: normalized.resource } : {}),
    allowed: actionAllowed(policy.access, action),
    reason: policy.access.reason,
  };
}

export function evaluateOrganizationRead(input: OrganizationPolicyInput): OrganizationAccessEvaluation {
  return evaluateOrganizationAccess({ ...input, action: "read" });
}

export function evaluateOrganizationShare(input: OrganizationPolicyInput): OrganizationAccessEvaluation {
  return evaluateOrganizationAccess({ ...input, action: "share" });
}

export function evaluateOrganizationAdmin(input: OrganizationPolicyInput): OrganizationAccessEvaluation {
  return evaluateOrganizationAccess({ ...input, action: "admin" });
}

export function evaluateOrganizationPolicyAction(input: OrganizationPolicyInput): OrganizationAccessEvaluation {
  return evaluateOrganizationAccess({ ...input, action: "policy" });
}

export const evaluateOrganizationPolicyAccess = evaluateOrganizationAccess;
export const evaluateOrganizationOrganizationAccess = evaluateOrganizationAccess;

function normalizeRevisionInput(input: unknown): OrganizationPolicyRevisionValidationResult {
  if (!isRecord(input)) {
    return { valid: false, errors: [issue("ORGANIZATION_REVISION_INVALID", "Organization policy revision input must be an object.")] };
  }
  const errors: OrganizationPolicyValidationIssue[] = [];
  for (const key of unknownKeys(input, ["organizationId", "policy", "reason"])) {
    errors.push(issue("ORGANIZATION_REVISION_INVALID", `Organization policy revision field '${key}' is not accepted.`, key));
  }
  if (!validIdentifier(input.organizationId)) {
    errors.push(issue("ORGANIZATION_ID_INVALID", "Organization policy revision organizationId must be a bounded identifier.", "organizationId"));
  }
  if (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length > 500)) {
    errors.push(issue("ORGANIZATION_REVISION_REASON_INVALID", "Organization policy revision reason must be at most 500 characters.", "reason"));
  }
  const policyResult = validateOrganizationPolicyV1(input.policy);
  if (!policyResult.valid) errors.push(...policyResult.errors.map((error) => ({ ...error, path: error.path ? `policy.${error.path}` : "policy" })));
  if (errors.length > 0 || !policyResult.valid) return { valid: false, errors };
  const policy = clonePolicy(policyResult.value);
  const reason = input.reason === undefined ? "" : input.reason as string;
  return {
    valid: true,
    value: {
      organizationId: input.organizationId as string,
      policy,
      policySha256: organizationPolicyDigest(policy),
      reason,
    },
  };
}

/** Normalize an append-only policy revision input and calculate its digest. */
export function validateOrganizationPolicyRevisionInput(input: unknown): OrganizationPolicyRevisionValidationResult {
  return normalizeRevisionInput(input);
}

export function normalizeOrganizationPolicyRevisionInput(input: unknown): NormalizedOrganizationPolicyRevisionInput {
  const result = validateOrganizationPolicyRevisionInput(input);
  if (!result.valid) throw new OrganizationTenancyValidationError(result.errors);
  return {
    organizationId: result.value.organizationId,
    policy: clonePolicy(result.value.policy),
    policySha256: result.value.policySha256,
    reason: result.value.reason,
  };
}

export function assertValidOrganizationPolicyRevisionInput(input: unknown): NormalizedOrganizationPolicyRevisionInput {
  return normalizeOrganizationPolicyRevisionInput(input);
}

export const organizationPolicyRevisionDigest = organizationPolicyDigest;
export const digestOrganizationPolicyRevision = organizationPolicyDigest;
