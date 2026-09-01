import {
  AppError,
  normalizeOrganizationPolicyV1,
  organizationPolicyDigest,
  type OrganizationMembershipRole,
  type OrganizationPolicyRevision,
  type OrganizationPolicyV1,
} from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type {
  CreateOrganizationStoreInput,
  OrganizationAuditEvent,
  OrganizationAuditInput,
  OrganizationCreatedResult,
  OrganizationInvitationRecord,
  OrganizationMembershipRecord,
  OrganizationRecord,
  OrganizationPolicyAppendResult,
  OrganizationPolicyActivationResult,
  OrganizationStore,
} from "./types.js";

type MemoryOrganization = OrganizationRecord;
type MemoryMembership = OrganizationMembershipRecord;
type MemoryInvitation = OrganizationInvitationRecord;
type MemoryAuditEvent = OrganizationAuditEvent;

interface KnownUser {
  id: string;
  email: string;
  name: string;
}

export interface MemoryOrganizationStoreOptions {
  /** Injectable clock keeps focused service tests deterministic. */
  now?: () => Date;
  /** Test-only failure injection before a mutation and its allow audit commit. */
  beforeCommit?: (input: OrganizationAuditInput) => void | Promise<void>;
}

/**
 * A deterministic in-memory implementation of the organization persistence
 * boundary. The maps model the same aggregate boundaries as the Postgres
 * tables, while the service owns authorization and input normalization.
 */
export class MemoryOrganizationStore implements OrganizationStore {
  readonly kind = "memory" as const;

  private readonly organizations = new Map<string, MemoryOrganization>();
  private readonly memberships = new Map<string, MemoryMembership>();
  private readonly invitations = new Map<string, MemoryInvitation>();
  private readonly policyRevisions = new Map<string, OrganizationPolicyRevision>();
  private readonly audit: MemoryAuditEvent[] = [];
  private readonly usersByEmail = new Map<string, KnownUser>();
  private readonly now: () => Date;
  private readonly beforeCommit?: (input: OrganizationAuditInput) => void | Promise<void>;
  private nextOrganizationNumber = 1;
  private nextMembershipNumber = 1;
  private nextInvitationNumber = 1;
  private nextPolicyRevisionNumber = 1;
  private nextAuditNumber = 1;

  constructor(options: MemoryOrganizationStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.beforeCommit = options.beforeCommit;
  }

  /** Seed the user lookup used to materialize accepted memberships. */
  addKnownUser(input: { id: string; email: string; name?: string }): void {
    const user = {
      id: input.id,
      email: normalizeEmail(input.email),
      name: input.name ?? "",
    };
    this.usersByEmail.set(user.email, user);
  }

  /** Alias used by fixtures that call this a user registry. */
  registerUser(input: { id: string; email: string; name?: string }): void {
    this.addKnownUser(input);
  }

  async createOrganization(input: CreateOrganizationStoreInput): Promise<OrganizationCreatedResult> {
    if (this.organizations.has(input.id ?? "")) {
      throw new AppError("Organization name is already in use.", "ORGANIZATION_ALREADY_EXISTS", 409);
    }
    if ([...this.organizations.values()].some((organization) => organization.slug === input.slug)) {
      throw new AppError("Organization name is already in use.", "ORGANIZATION_ALREADY_EXISTS", 409);
    }
    if (organizationPolicyDigest(input.policy) !== input.policySha256) {
      throw new AppError("Organization policy digest is invalid.", "ORGANIZATION_POLICY_DIGEST_INVALID", 400);
    }

    // Stage every row before mutating a map. This mirrors the service's
    // one-operation create contract and prevents partial memory state.
    const now = this.timestamp();
    const organizationId = input.id ?? `organization-${this.nextOrganizationNumber}`;
    const policyRevisionId = `organization-policy-revision-${this.nextPolicyRevisionNumber}`;
    const membershipId = `organization-membership-${this.nextMembershipNumber}`;
    const organization: MemoryOrganization = {
      id: organizationId,
      name: input.name,
      slug: input.slug,
      status: "active",
      currentPolicyRevisionId: policyRevisionId,
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
    };
    const policyRevision: OrganizationPolicyRevision = {
      id: policyRevisionId,
      organizationId,
      revisionNumber: 1,
      policy: clonePolicy(input.policy),
      policySha256: input.policySha256,
      reason: input.reason,
      createdByUserId: input.createdByUserId,
      createdAt: now,
    };
    const membership: MemoryMembership = {
      id: membershipId,
      organizationId,
      userId: input.createdByUserId,
      email: normalizeEmail(input.creatorEmail),
      name: input.creatorName,
      role: "owner",
      invitedByUserId: null,
      removedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const audit = await this.prepareAllowAudit(input.audit, organization.id, {
      organizationSlug: organization.slug,
      policyRevisionNumber: policyRevision.revisionNumber,
      policySha256: policyRevision.policySha256,
    });
    this.organizations.set(organization.id, organization);
    this.policyRevisions.set(policyRevision.id, policyRevision);
    this.memberships.set(membershipKey(organization.id, membership.userId), membership);
    this.nextOrganizationNumber += 1;
    this.nextPolicyRevisionNumber += 1;
    this.nextMembershipNumber += 1;
    this.addKnownUser({ id: membership.userId, email: membership.email, name: membership.name });
    this.commitPreparedAudit(audit);

    return {
      organization: cloneOrganization(organization),
      membership: cloneMembership(membership),
      policyRevision: clonePolicyRevision(policyRevision),
    };
  }

  async listOrganizations(): Promise<OrganizationRecord[]> {
    return [...this.organizations.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      .map(cloneOrganization);
  }

  async getOrganization(organizationId: string): Promise<OrganizationRecord | null> {
    const organization = this.organizations.get(organizationId);
    return organization ? cloneOrganization(organization) : null;
  }

  async findMembership(input: {
    organizationId: string;
    userId: string;
    includeRemoved?: boolean;
  }): Promise<OrganizationMembershipRecord | null> {
    const membership = this.memberships.get(membershipKey(input.organizationId, input.userId));
    if (!membership || (!input.includeRemoved && membership.removedAt !== null)) return null;
    return cloneMembership(membership);
  }

  async listMemberships(input: { organizationId: string; includeRemoved?: boolean }): Promise<OrganizationMembershipRecord[]> {
    return [...this.memberships.values()]
      .filter((membership) => (
        membership.organizationId === input.organizationId
        && (input.includeRemoved || membership.removedAt === null)
      ))
      .sort((left, right) => left.email.localeCompare(right.email) || left.userId.localeCompare(right.userId))
      .map(cloneMembership);
  }

  async listInvitations(input: { organizationId: string }): Promise<OrganizationInvitationRecord[]> {
    return [...this.invitations.values()]
      .filter((invitation) => invitation.organizationId === input.organizationId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
      .map(cloneInvitation);
  }

  async listInvitationsForEmail(normalizedEmail: string): Promise<OrganizationInvitationRecord[]> {
    const email = normalizeEmail(normalizedEmail);
    return [...this.invitations.values()]
      .filter((invitation) => invitation.normalizedEmail === email && invitation.status === "pending")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
      .map(cloneInvitation);
  }

  async createInvitation(input: {
    organizationId: string;
    email: string;
    normalizedEmail: string;
    role: OrganizationMembershipRole;
    invitedByUserId: string;
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationInvitationRecord> {
    const organization = this.organizations.get(input.organizationId);
    if (!organization) throw new AppError("Organization not found.", "ORGANIZATION_NOT_FOUND", 404);
    if (organization.status !== "active") throw new AppError("Organization is not active.", "ORGANIZATION_INACTIVE", 409);
    this.currentOrganizationPolicy(organization);
    const inviterMembership = this.memberships.get(membershipKey(input.organizationId, input.invitedByUserId));
    if (!inviterMembership || inviterMembership.removedAt !== null
      || (inviterMembership.role !== "owner" && inviterMembership.role !== "admin")) {
      throw new AppError("Organization admin access is required.", "ORGANIZATION_ADMIN_REQUIRED", 403);
    }
    if (input.role === "owner" && inviterMembership.role !== "owner") {
      throw new AppError("Organization owner access is required.", "ORGANIZATION_OWNER_REQUIRED", 403);
    }
    if ([...this.invitations.values()].some((invitation) => (
      invitation.organizationId === input.organizationId
      && invitation.normalizedEmail === input.normalizedEmail
      && invitation.status === "pending"
    ))) {
      throw new AppError("Organization invitation already exists.", "ORGANIZATION_INVITATION_EXISTS", 409);
    }

    const knownUser = this.usersByEmail.get(input.normalizedEmail);
    if (knownUser) {
      const membership = this.memberships.get(membershipKey(input.organizationId, knownUser.id));
      if (membership?.removedAt === null) {
        throw new AppError("User is already an organization member.", "ORGANIZATION_MEMBER_EXISTS", 409);
      }
    }

    const now = this.timestamp();
    const invitation: MemoryInvitation = {
      id: `organization-invitation-${this.nextInvitationNumber}`,
      organizationId: input.organizationId,
      organizationName: organization.name,
      email: input.email,
      normalizedEmail: input.normalizedEmail,
      role: input.role,
      status: "pending",
      invitedByUserId: input.invitedByUserId,
      acceptedByUserId: null,
      acceptedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const audit = await this.prepareAllowAudit(input.audit, input.organizationId);
    this.invitations.set(invitation.id, invitation);
    this.nextInvitationNumber += 1;
    this.commitPreparedAudit(audit);
    return cloneInvitation(invitation);
  }

  async acceptInvitation(input: {
    invitationId: string;
    userId: string;
    email: string;
    name: string;
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationInvitationRecord | null> {
    const invitation = this.invitations.get(input.invitationId);
    const normalizedEmail = normalizeEmail(input.email);
    if (!invitation || invitation.status !== "pending" || invitation.normalizedEmail !== normalizedEmail) return null;
    const organization = this.organizations.get(invitation.organizationId);
    if (!organization || organization.status !== "active") return null;
    const policy = this.currentOrganizationPolicy(organization);
    const knownUser = this.usersByEmail.get(normalizedEmail);
    // Memory fixtures may introduce an authenticated actor on first
    // invitation acceptance. If an email is already known, however, never
    // allow a different user ID to claim that identity.
    if (knownUser && knownUser.id !== input.userId) return null;

    const now = this.timestamp();
    const key = membershipKey(invitation.organizationId, input.userId);
    const existing = this.memberships.get(key);
    const nextInvitation = cloneInvitation(invitation);
    let nextMembership: MemoryMembership | null = null;
    let addMembership = false;
    if (existing && existing.removedAt === null) {
      // Accepting a duplicate invitation is idempotent for an already-active
      // member, but never changes the member's existing role.
      nextInvitation.status = "accepted";
      nextInvitation.acceptedByUserId = input.userId;
      nextInvitation.acceptedAt = now;
      nextInvitation.updatedAt = now;
    } else if (existing) {
      if (this.activeMemberCount(invitation.organizationId) >= policy.limits.membersPerOrganization) {
        throw new AppError(
          "Organization member limit has been reached.",
          "ORGANIZATION_MEMBER_LIMIT_REACHED",
          409,
          { limit: policy.limits.membersPerOrganization },
        );
      }
      nextMembership = {
        ...existing,
        email: normalizedEmail,
        name: input.name,
        role: invitation.role,
        removedAt: null,
        updatedAt: now,
      };
      nextInvitation.status = "accepted";
      nextInvitation.acceptedByUserId = input.userId;
      nextInvitation.acceptedAt = now;
      nextInvitation.updatedAt = now;
    } else {
      if (this.activeMemberCount(invitation.organizationId) >= policy.limits.membersPerOrganization) {
        throw new AppError(
          "Organization member limit has been reached.",
          "ORGANIZATION_MEMBER_LIMIT_REACHED",
          409,
          { limit: policy.limits.membersPerOrganization },
        );
      }
      nextMembership = {
        id: `organization-membership-${this.nextMembershipNumber}`,
        organizationId: invitation.organizationId,
        userId: input.userId,
        email: normalizedEmail,
        name: input.name,
        role: invitation.role,
        invitedByUserId: invitation.invitedByUserId,
        removedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      addMembership = true;
      nextInvitation.status = "accepted";
      nextInvitation.acceptedByUserId = input.userId;
      nextInvitation.acceptedAt = now;
      nextInvitation.updatedAt = now;
    }
    const audit = await this.prepareAllowAudit(input.audit, invitation.organizationId, { invitationId: invitation.id });
    if (nextMembership) {
      this.memberships.set(key, nextMembership);
      if (addMembership) this.nextMembershipNumber += 1;
    }
    this.invitations.set(nextInvitation.id, nextInvitation);
    this.addKnownUser({ id: input.userId, email: normalizedEmail, name: input.name });
    this.commitPreparedAudit(audit);
    return cloneInvitation(nextInvitation);
  }

  async updateMembershipRole(input: {
    organizationId: string;
    userId: string;
    role: OrganizationMembershipRole;
    actorUserId: string;
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationMembershipRecord | null> {
    const organization = this.organizations.get(input.organizationId);
    if (organization) this.currentOrganizationPolicy(organization);
    const actorRole = this.assertActorRole(input.organizationId, input.actorUserId, "admin");
    const membership = this.memberships.get(membershipKey(input.organizationId, input.userId));
    if (!membership || membership.removedAt !== null) return null;
    if (actorRole === "admin" && (membership.role === "owner" || input.role === "owner")) {
      throw new AppError("Organization owner access is required.", "ORGANIZATION_OWNER_REQUIRED", 403);
    }
    if (membership.role === "owner" && input.role !== "owner" && this.activeOwnerCount(input.organizationId) <= 1) {
      throw new AppError("At least one active organization owner is required.", "LAST_ORGANIZATION_OWNER_REQUIRED", 409);
    }
    const updated = {
      ...membership,
      role: input.role,
      updatedAt: this.timestamp(),
    };
    const audit = await this.prepareAllowAudit(input.audit, input.organizationId, {
      memberId: input.userId,
      roleBefore: membership.role,
      roleAfter: updated.role,
    });
    this.memberships.set(membershipKey(input.organizationId, input.userId), updated);
    this.commitPreparedAudit(audit);
    return cloneMembership(updated);
  }

  async removeMembership(input: {
    organizationId: string;
    userId: string;
    actorUserId: string;
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationMembershipRecord | null> {
    const organization = this.organizations.get(input.organizationId);
    if (organization) this.currentOrganizationPolicy(organization);
    const actorRole = this.assertActorRole(input.organizationId, input.actorUserId, "admin");
    const membership = this.memberships.get(membershipKey(input.organizationId, input.userId));
    if (!membership || membership.removedAt !== null) return null;
    if (actorRole === "admin" && membership.role === "owner") {
      throw new AppError("Organization owner access is required.", "ORGANIZATION_OWNER_REQUIRED", 403);
    }
    if (membership.role === "owner" && this.activeOwnerCount(input.organizationId) <= 1) {
      throw new AppError("At least one active organization owner is required.", "LAST_ORGANIZATION_OWNER_REQUIRED", 409);
    }
    const now = this.timestamp();
    const removed = {
      ...membership,
      removedAt: now,
      updatedAt: now,
    };
    const audit = await this.prepareAllowAudit(input.audit, input.organizationId, {
      memberId: input.userId,
      roleBefore: membership.role,
    });
    this.memberships.set(membershipKey(input.organizationId, input.userId), removed);
    this.commitPreparedAudit(audit);
    return cloneMembership(removed);
  }

  async listPolicyRevisions(organizationId: string): Promise<OrganizationPolicyRevision[]> {
    return [...this.policyRevisions.values()]
      .filter((revision) => revision.organizationId === organizationId)
      .sort((left, right) => right.revisionNumber - left.revisionNumber || left.id.localeCompare(right.id))
      .map(clonePolicyRevision);
  }

  async getPolicyRevision(input: { organizationId: string; revisionId?: string }): Promise<OrganizationPolicyRevision | null> {
    const revision = input.revisionId
      ? this.policyRevisions.get(input.revisionId)
      : [...this.policyRevisions.values()]
        .filter((candidate) => candidate.organizationId === input.organizationId)
        .sort((left, right) => right.revisionNumber - left.revisionNumber)[0];
    if (!revision || revision.organizationId !== input.organizationId) return null;
    return clonePolicyRevision(revision);
  }

  async appendPolicyRevision(input: {
    organizationId: string;
    policy: OrganizationPolicyV1;
    policySha256: string;
    reason: string;
    createdByUserId: string;
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationPolicyAppendResult> {
    const organization = this.organizations.get(input.organizationId);
    if (!organization) throw new AppError("Organization not found.", "ORGANIZATION_NOT_FOUND", 404);
    if (organization.status !== "active") {
      throw new AppError("Organization is not active.", "ORGANIZATION_INACTIVE", 409);
    }
    const creatorMembership = this.memberships.get(membershipKey(input.organizationId, input.createdByUserId));
    if (!creatorMembership || creatorMembership.removedAt !== null || creatorMembership.role !== "owner") {
      throw new AppError("Organization owner access is required.", "ORGANIZATION_OWNER_REQUIRED", 403);
    }
    if (organizationPolicyDigest(input.policy) !== input.policySha256) {
      throw new AppError("Organization policy digest is invalid.", "ORGANIZATION_POLICY_DIGEST_INVALID", 400);
    }
    const existing = [...this.policyRevisions.values()].find((revision) => (
      revision.organizationId === input.organizationId && revision.policySha256 === input.policySha256
    ));
    if (existing) {
      const now = this.timestamp();
      const updatedOrganization = {
        ...organization,
        currentPolicyRevisionId: existing.id,
        updatedAt: now,
      };
      const audit = await this.prepareAllowAudit(input.audit, input.organizationId, {
        revisionNumber: existing.revisionNumber,
        policySha256: existing.policySha256,
        created: false,
        activated: true,
      });
      this.organizations.set(organization.id, updatedOrganization);
      this.commitPreparedAudit(audit);
      return { revision: clonePolicyRevision(existing), created: false, activated: true };
    }

    const revisionNumber = [...this.policyRevisions.values()]
      .filter((revision) => revision.organizationId === input.organizationId)
      .reduce((highest, revision) => Math.max(highest, revision.revisionNumber), 0) + 1;
    const now = this.timestamp();
    const revision: OrganizationPolicyRevision = {
      id: `organization-policy-revision-${this.nextPolicyRevisionNumber}`,
      organizationId: input.organizationId,
      revisionNumber,
      policy: clonePolicy(input.policy),
      policySha256: input.policySha256,
      reason: input.reason,
      createdByUserId: input.createdByUserId,
      createdAt: now,
    };
    const updatedOrganization = {
      ...organization,
      currentPolicyRevisionId: revision.id,
      updatedAt: now,
    };
    const audit = await this.prepareAllowAudit(input.audit, input.organizationId, {
      revisionNumber: revision.revisionNumber,
      policySha256: revision.policySha256,
      created: true,
      activated: true,
    });
    this.policyRevisions.set(revision.id, revision);
    this.nextPolicyRevisionNumber += 1;
    this.organizations.set(organization.id, updatedOrganization);
    this.commitPreparedAudit(audit);
    return { revision: clonePolicyRevision(revision), created: true, activated: true };
  }

  async activatePolicyRevision(input: {
    organizationId: string;
    revisionId: string;
    actorUserId: string;
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationPolicyActivationResult | null> {
    const organization = this.organizations.get(input.organizationId);
    if (!organization) return null;
    if (organization.status !== "active") {
      throw new AppError("Organization is not active.", "ORGANIZATION_INACTIVE", 409);
    }
    this.assertActorRole(input.organizationId, input.actorUserId, "owner");
    const revision = this.policyRevisions.get(input.revisionId);
    if (!revision || revision.organizationId !== input.organizationId) return null;
    const changed = organization.currentPolicyRevisionId !== revision.id;
    const updatedOrganization = changed
      ? { ...organization, currentPolicyRevisionId: revision.id, updatedAt: this.timestamp() }
      : organization;
    const audit = await this.prepareAllowAudit(input.audit, input.organizationId, {
      revisionNumber: revision.revisionNumber,
      policySha256: revision.policySha256,
    });
    if (changed) this.organizations.set(organization.id, updatedOrganization);
    this.commitPreparedAudit(audit);
    return { revision: clonePolicyRevision(revision), activated: true, changed };
  }

  async archiveOrganization(input: {
    organizationId: string;
    actorUserId: string;
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationRecord | null> {
    const organization = this.organizations.get(input.organizationId);
    if (!organization) return null;
    this.assertActorRole(input.organizationId, input.actorUserId, "owner");
    const archived = { ...organization, status: "archived" as const, updatedAt: this.timestamp() };
    const audit = await this.prepareAllowAudit(input.audit, input.organizationId, {
      previousStatus: organization.status,
      status: archived.status,
    });
    this.organizations.set(organization.id, archived);
    this.commitPreparedAudit(audit);
    return cloneOrganization(archived);
  }

  async recordAuditEvent(input: OrganizationAuditInput): Promise<void> {
    this.commitPreparedAudit(this.createAuditEvent(input));
  }

  private async prepareAllowAudit(
    input: OrganizationAuditInput | undefined,
    resourceId: string,
    details: Record<string, unknown> = {},
  ): Promise<MemoryAuditEvent | null> {
    if (!input) return null;
    const prepared = {
      ...input,
      resourceId: resourceId,
      details: { ...input.details, ...details },
    };
    await this.beforeCommit?.(prepared);
    return this.createAuditEvent(prepared);
  }

  private commitPreparedAudit(event: MemoryAuditEvent | null): void {
    if (!event) return;
    this.audit.push({ ...event, id: `organization-audit-${this.nextAuditNumber}` });
    this.nextAuditNumber += 1;
  }

  private createAuditEvent(input: OrganizationAuditInput): MemoryAuditEvent {
    return {
      id: `organization-audit-${this.nextAuditNumber}`,
      actorUserId: input.actorUserId,
      action: input.action,
      decision: input.decision,
      resourceId: input.resourceId ?? null,
      details: sanitizeAuditDetails(input.details ?? {}),
      createdAt: this.timestamp(),
    };
  }

  async listAuditEvents(limit = 100): Promise<OrganizationAuditEvent[]> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
    return this.audit.slice(-boundedLimit).reverse().map((event) => ({
      ...event,
      details: structuredClone(event.details),
    }));
  }

  auditEvents(): OrganizationAuditEvent[] {
    return this.audit.map((event) => ({ ...event, details: structuredClone(event.details) }));
  }

  private activeOwnerCount(organizationId: string): number {
    return [...this.memberships.values()].filter((membership) => (
      membership.organizationId === organizationId
      && membership.removedAt === null
      && membership.role === "owner"
    )).length;
  }

  private activeMemberCount(organizationId: string): number {
    return [...this.memberships.values()].filter((membership) => (
      membership.organizationId === organizationId && membership.removedAt === null
    )).length;
  }

  private assertActorRole(
    organizationId: string,
    actorUserId: string,
    minimum: "admin" | "owner",
  ): OrganizationMembershipRole {
    const organization = this.organizations.get(organizationId);
    if (!organization) throw new AppError("Organization not found.", "ORGANIZATION_NOT_FOUND", 404);
    if (organization.status !== "active") {
      throw new AppError("Organization is not active.", "ORGANIZATION_INACTIVE", 409);
    }
    const membership = this.memberships.get(membershipKey(organizationId, actorUserId));
    const allowed = membership
      && membership.removedAt === null
      && (minimum === "owner"
        ? membership.role === "owner"
        : membership.role === "owner" || membership.role === "admin");
    if (!allowed) {
      throw new AppError(
        minimum === "owner" ? "Organization owner access is required." : "Organization admin access is required.",
        minimum === "owner" ? "ORGANIZATION_OWNER_REQUIRED" : "ORGANIZATION_ADMIN_REQUIRED",
        403,
      );
    }
    return membership.role;
  }

  private currentOrganizationPolicy(organization: MemoryOrganization): OrganizationPolicyV1 {
    const revisionId = organization.currentPolicyRevisionId;
    const revision = revisionId ? this.policyRevisions.get(revisionId) : undefined;
    if (!revision || revision.organizationId !== organization.id) {
      throw new AppError("Organization policy is unavailable.", "ORGANIZATION_POLICY_UNAVAILABLE", 500);
    }
    let policy: OrganizationPolicyV1;
    try {
      policy = normalizeOrganizationPolicyV1(revision.policy);
    } catch {
      throw new AppError("Organization policy is invalid.", "ORGANIZATION_POLICY_INVALID", 500);
    }
    if (organizationPolicyDigest(policy) !== revision.policySha256) {
      throw new AppError("Organization policy digest is invalid.", "ORGANIZATION_POLICY_DIGEST_INVALID", 409);
    }
    return policy;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function membershipKey(organizationId: string, userId: string): string {
  return `${organizationId}\u0000${userId}`;
}

function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

function cloneOrganization(organization: OrganizationRecord): OrganizationRecord {
  return { ...organization };
}

function cloneMembership(membership: OrganizationMembershipRecord): OrganizationMembershipRecord {
  return { ...membership };
}

function cloneInvitation(invitation: OrganizationInvitationRecord): OrganizationInvitationRecord {
  return { ...invitation };
}

function clonePolicyRevision(revision: OrganizationPolicyRevision): OrganizationPolicyRevision {
  return {
    ...revision,
    policy: clonePolicy(revision.policy),
  };
}

function clonePolicy(policy: OrganizationPolicyV1): OrganizationPolicyV1 {
  return {
    schemaVersion: policy.schemaVersion,
    sharing: { ...policy.sharing },
    teams: { ...policy.teams },
    limits: { ...policy.limits },
  };
}
