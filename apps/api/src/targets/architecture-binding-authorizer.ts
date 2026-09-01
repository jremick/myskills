import {
  validateOrganizationPolicyV1,
  type ArchitectureEnvironment,
  type ArchitectureProfile,
  type ArchitectureTargetOwnerReference,
  type OrganizationMembershipRole,
  type OrganizationPolicyV1,
} from "@myskills-app/core";
import type {
  ArchitectureRecord,
  ArchitectureRevisionRecord,
  ArchitectureStore,
} from "../architectures/types.js";
import type {
  ArchitectureTargetBinding,
  ArchitectureTargetBindingAuthorization,
  ArchitectureTargetBindingAuthorizationContext,
  ArchitectureTargetBindingAuthorizer as ArchitectureTargetBindingAuthorizerContract,
  ArchitectureTargetBindingRequest,
} from "./types.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Reasons are deliberately short and contain no resource identifiers. */
export const architectureTargetBindingDenialReasons = [
  "invalid-request",
  "not-authorized",
  "owner-mismatch",
  "management-required",
  "environment-not-found",
  "profile-not-found",
  "environment-profile-mismatch",
  "organization-management-required",
  "organization-policy-disabled",
] as const;

export type ArchitectureTargetBindingDenialReason =
  (typeof architectureTargetBindingDenialReasons)[number];

/**
 * A current membership authority must resolve the membership at authorization
 * time. OrganizationStore implements this shape directly. The optional policy
 * and status fields let a richer authority expose gates without making those
 * fields part of the target binding request.
 */
export interface ArchitectureTargetOrganizationMembershipAuthority {
  findMembership(input: {
    organizationId: string;
    userId: string;
    includeRemoved?: boolean;
  }): Promise<{
    organizationId: string;
    userId: string;
    role: OrganizationMembershipRole;
    removedAt?: string | null;
    organizationStatus?: string;
    policy?: OrganizationPolicyV1;
    canRegisterArchitectureTargets?: boolean;
  } | null>;
}

export interface ArchitectureTargetBindingAuthorizerOptions {
  organizationMembershipAuthority?: ArchitectureTargetOrganizationMembershipAuthority;
}

/**
 * Authorizes the binding of a physical target to one exact architecture
 * environment/profile. ArchitectureStore remains the source of truth for
 * architecture visibility, ownership, memberships, grants, and the current
 * revision. This class only returns server-derived binding metadata.
 */
export class ArchitectureTargetBindingAuthorizer implements ArchitectureTargetBindingAuthorizerContract {
  private readonly organizationMembershipAuthority?: ArchitectureTargetOrganizationMembershipAuthority;

  constructor(
    private readonly architectureStore: ArchitectureStore,
    authorityOrOptions?: ArchitectureTargetOrganizationMembershipAuthority | ArchitectureTargetBindingAuthorizerOptions,
  ) {
    this.organizationMembershipAuthority = isMembershipAuthority(authorityOrOptions)
      ? authorityOrOptions
      : authorityOrOptions?.organizationMembershipAuthority;
  }

  async authorizeBinding(input: ArchitectureTargetBindingRequest): Promise<ArchitectureTargetBindingAuthorization> {
    const request = normalizeRequest(input);
    if (!request) return denied("invalid-request");

    try {
      // Pass only the actor identity. Client-supplied membership snapshots are
      // not an authority and must never widen the store's access decision.
      const architecture = await this.architectureStore.getArchitecture(
        request.actorUserId,
        request.architectureId,
      );
      if (!architecture || !isVisibleArchitecture(architecture, request.architectureId)) {
        return denied("not-authorized");
      }

      const currentRevision = await currentRevisionFor(
        this.architectureStore,
        request.actorUserId,
        architecture,
        request.requestedOwner.type === "organization" ? request.requestedOwner.id : undefined,
      );
      if (!currentRevision) return denied("not-authorized");

      const context = bindingContext(currentRevision, request);
      if (context.reason) return denied(context.reason);

      if (request.requestedOwner.type === "organization") {
        return await this.authorizeOrganizationBinding(
          architecture,
          request,
          context.environment,
          context.profile,
          currentRevision.id,
        );
      }

      if (!sameOwner(request.requestedOwner, architecture.owner)) {
        return denied("owner-mismatch");
      }

      // Architecture access is resolved by the store for this actor. Both
      // create and policy-management authority are required; a team member
      // can read/preview but can never register a target.
      if (architecture.access.role !== "owner" || !architecture.access.canCreate || !architecture.access.canManage) {
        return denied("management-required");
      }

      const binding = {
        owner: cloneOwner(architecture.owner),
        architectureId: architecture.id,
        environmentId: context.environment.id,
        profileId: context.profile.id,
      } satisfies ArchitectureTargetBinding;
      return allowed(binding, authorizationContext(request, binding, currentRevision.id));
    } catch {
      // Hidden, stale, malformed, or unavailable records have one bounded
      // response. Do not echo store errors, specs, or identifiers.
      return denied("not-authorized");
    }
  }

  private async authorizeOrganizationBinding(
    architecture: ArchitectureRecord,
    request: NormalizedBindingRequest,
    environment: ArchitectureEnvironment,
    profile: ArchitectureProfile,
    currentRevisionId: string,
  ): Promise<ArchitectureTargetBindingAuthorization> {
    const organizationId = request.requestedOwner.id;

    // The architecture store has already evaluated the exact current grant,
    // global switch, policy, organization status, and actor membership. Never
    // replace this with a profile subject or a broad actor organization list.
    if (!architecture.access.canRead || !architecture.access.allowedOrganizationIds?.includes(organizationId)) {
      return denied("not-authorized");
    }

    const authority = this.organizationMembershipAuthority;
    if (!authority) return denied("not-authorized");
    const membership = await authority.findMembership({
      organizationId,
      userId: request.actorUserId,
      includeRemoved: false,
    });
    if (!membership
      || membership.organizationId !== organizationId
      || membership.userId !== request.actorUserId
      || membership.removedAt !== undefined && membership.removedAt !== null
      || membership.role !== "owner" && membership.role !== "admin"
    ) {
      return denied("organization-management-required");
    }
    if (membership.organizationStatus !== undefined && membership.organizationStatus !== "active") {
      return denied("not-authorized");
    }
    if (membership.canRegisterArchitectureTargets === false) {
      return denied("organization-policy-disabled");
    }
    if (membership.policy !== undefined && !organizationPolicyAllowsTargetBinding(membership.policy)) {
      return denied("organization-policy-disabled");
    }

    const binding = {
      // The organization identity comes from the current membership authority,
      // while every architecture/context identifier comes from server rows.
      owner: { type: "organization", id: membership.organizationId },
      architectureId: architecture.id,
      environmentId: environment.id,
      profileId: profile.id,
    } satisfies ArchitectureTargetBinding;
    return allowed(binding, authorizationContext(request, binding, currentRevisionId));
  }
}

interface NormalizedBindingRequest {
  actorUserId: string;
  requestedOwner: ArchitectureTargetOwnerReference;
  architectureId: string;
  environmentId: string;
  profileId: string;
}

function normalizeRequest(input: ArchitectureTargetBindingRequest): NormalizedBindingRequest | null {
  if (!isPlainObject(input) || !hasOnlyKeys(input, ["actor", "actorUserId", "requestedOwner", "owner", "architectureId", "environmentId", "profileId"])) return null;
  if (!isPlainObject(input.actor) || !hasOnlyKeys(input.actor, ["userId"])) return null;
  if (!isIdentifier(input.actor.userId) || !isIdentifier(input.actorUserId)) return null;
  if (input.actor.userId !== input.actorUserId) return null;
  if (!isIdentifier(input.architectureId) || !isIdentifier(input.environmentId) || !isIdentifier(input.profileId)) return null;

  const requestedOwner = normalizeOwner(input.requestedOwner);
  const ownerAlias = normalizeOwner(input.owner);
  if (!requestedOwner || !ownerAlias || !sameOwner(requestedOwner, ownerAlias)) return null;

  return {
    actorUserId: input.actorUserId,
    requestedOwner,
    architectureId: input.architectureId,
    environmentId: input.environmentId,
    profileId: input.profileId,
  };
}

function normalizeOwner(input: unknown): ArchitectureTargetOwnerReference | null {
  if (!isPlainObject(input) || !hasOnlyKeys(input, ["type", "id"])) return null;
  const candidate = input as { type?: unknown; id?: unknown };
  if (candidate.type !== "user" && candidate.type !== "team" && candidate.type !== "organization") return null;
  if (!isIdentifier(candidate.id)) return null;
  return { type: candidate.type, id: candidate.id };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isVisibleArchitecture(architecture: ArchitectureRecord, requestedId: string): boolean {
  return architecture.id === requestedId && architecture.access.canRead;
}

async function currentRevisionFor(
  store: ArchitectureStore,
  actorUserId: string,
  architecture: ArchitectureRecord,
  organizationId?: string,
): Promise<ArchitectureRevisionRecord | null> {
  const currentRevisionId = architecture.currentRevisionId;
  if (!isIdentifier(currentRevisionId)) return null;
  const revision = organizationId === undefined
    ? await store.getRevision(actorUserId, architecture.id, currentRevisionId)
    : await store.getRevisionForPreview(actorUserId, architecture.id, currentRevisionId, organizationId);
  if (!revision
    || revision.id !== currentRevisionId
    || revision.architectureId !== architecture.id
    || !revision.spec
    || revision.spec.id !== architecture.id
  ) {
    return null;
  }
  return revision;
}

function bindingContext(
  revision: ArchitectureRevisionRecord,
  request: NormalizedBindingRequest,
): { environment: ArchitectureEnvironment; profile: ArchitectureProfile; reason?: undefined }
  | { environment?: undefined; profile?: undefined; reason: ArchitectureTargetBindingDenialReason } {
  const environments = Array.isArray(revision.spec.environments) ? revision.spec.environments : [];
  const profiles = Array.isArray(revision.spec.profiles) ? revision.spec.profiles : [];
  const environment = environments.find((candidate) => candidate?.id === request.environmentId);
  if (!environment) return { reason: "environment-not-found" };
  const profile = profiles.find((candidate) => candidate?.id === request.profileId);
  if (!profile) return { reason: "profile-not-found" };
  if (environment.profileId !== profile.id) return { reason: "environment-profile-mismatch" };
  if (!isIdentifier(environment.id) || !isIdentifier(profile.id)) return { reason: "not-authorized" };
  return { environment, profile };
}

function organizationPolicyAllowsTargetBinding(policy: OrganizationPolicyV1): boolean {
  const validation = validateOrganizationPolicyV1(policy);
  if (!validation.valid) return false;
  // v1 has no separate target-registration flag. Architecture sharing is the
  // existing core policy gate for an organization-owned physical binding.
  return validation.value.sharing.organizationArchitectureSharingEnabled === true;
}

function isMembershipAuthority(
  value: ArchitectureTargetOrganizationMembershipAuthority | ArchitectureTargetBindingAuthorizerOptions | undefined,
): value is ArchitectureTargetOrganizationMembershipAuthority {
  return Boolean(value && typeof value === "object" && typeof (value as ArchitectureTargetOrganizationMembershipAuthority).findMembership === "function");
}

function sameOwner(
  left: ArchitectureTargetOwnerReference,
  right: ArchitectureTargetOwnerReference,
): boolean {
  return left.type === right.type && left.id === right.id;
}

function cloneOwner(owner: ArchitectureTargetOwnerReference): ArchitectureTargetOwnerReference {
  return { type: owner.type, id: owner.id };
}

function authorizationContext(
  request: NormalizedBindingRequest,
  binding: ArchitectureTargetBinding,
  currentRevisionId: string,
): ArchitectureTargetBindingAuthorizationContext {
  return {
    actorUserId: request.actorUserId,
    owner: cloneOwner(binding.owner),
    architectureId: binding.architectureId,
    environmentId: binding.environmentId,
    profileId: binding.profileId,
    currentRevisionId,
  };
}

function allowed(
  binding: ArchitectureTargetBinding,
  authorization: ArchitectureTargetBindingAuthorizationContext,
): ArchitectureTargetBindingAuthorization {
  return { allowed: true, binding, authorization };
}

function denied(reason: ArchitectureTargetBindingDenialReason): ArchitectureTargetBindingAuthorization {
  return { allowed: false, reason };
}
