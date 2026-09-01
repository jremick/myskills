import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import {
  AppError,
  normalizeOrganizationPolicyV1,
  organizationPolicyDigest,
  type OrganizationMembershipRole,
  type OrganizationPolicyRevision,
  type OrganizationPolicyV1,
  type OrganizationStatus,
} from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type { Database } from "../db/client.js";
import {
  auditEvents,
  organizationInvitations,
  organizationMemberships,
  organizationPolicyRevisions,
  organizations,
  users,
} from "../db/schema.js";
import type {
  CreateOrganizationStoreInput,
  OrganizationAuditEvent,
  OrganizationAuditInput,
  OrganizationCreatedResult,
  OrganizationInvitationRecord,
  OrganizationMembershipRecord,
  OrganizationPolicyAppendResult,
  OrganizationPolicyActivationResult,
  OrganizationRecord,
  OrganizationStore,
} from "./types.js";

type DbLike = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface PostgresOrganizationStoreOptions {
  /** Test-only failure injection before a required allow audit insert. */
  beforeAuditInsert?: (input: OrganizationAuditInput) => void | Promise<void>;
}

/**
 * PostgreSQL persistence for the organization aggregate.
 *
 * Every mutation that can change organization membership or the active policy
 * first locks the organization row. This gives all store callers one lock
 * order and makes last-owner checks safe when requests race.
 */
export class PostgresOrganizationStore implements OrganizationStore {
  readonly kind = "postgres" as const;

  constructor(
    private readonly db: Database,
    private readonly options: PostgresOrganizationStoreOptions = {},
  ) {}

  async createOrganization(input: CreateOrganizationStoreInput): Promise<OrganizationCreatedResult> {
    assertPolicyDigest(input.policy, input.policySha256);

    try {
      return await this.db.transaction(async (tx) => {
        // Resolve the owner from the users table. The persisted membership
        // snapshot must come from the authoritative identity row.
        const [creator] = await tx
          .select({
            id: users.id,
            email: users.email,
            normalizedEmail: users.normalizedEmail,
            name: users.name,
            status: users.status,
          })
          .from(users)
          .where(eq(users.id, input.createdByUserId))
          .for("update")
          .limit(1);
        if (!creator || creator.status !== "active") {
          throw new AppError(
            "Organization owner was not found.",
            "ORGANIZATION_OWNER_NOT_FOUND",
            404,
          );
        }

        // Start in provisioning state because the active-state check requires
        // a current policy. The whole operation commits only after all three
        // aggregate rows and the active pointer have been written.
        const [organization] = await tx
          .insert(organizations)
          .values({
            ...(input.id ? { id: input.id } : {}),
            name: input.name,
            slug: input.slug,
            status: "provisioning",
            currentPolicyRevisionId: null,
            createdByUserId: input.createdByUserId,
          })
          .onConflictDoNothing()
          .returning();
        if (!organization) {
          throw new AppError(
            "Organization name is already in use.",
            "ORGANIZATION_ALREADY_EXISTS",
            409,
          );
        }

        const [policyRevision] = await tx
          .insert(organizationPolicyRevisions)
          .values({
            organizationId: organization.id,
            revisionNumber: 1,
            schemaVersion: input.policy.schemaVersion,
            policy: input.policy,
            policySha256: input.policySha256,
            reason: input.reason,
            createdByUserId: input.createdByUserId,
          })
          .returning();
        if (!policyRevision) {
          throw new Error("Organization policy revision insert failed.");
        }

        const [membership] = await tx
          .insert(organizationMemberships)
          .values({
            organizationId: organization.id,
            userId: creator.id,
            role: "owner",
            invitedByUserId: null,
          })
          .returning();
        if (!membership) {
          throw new Error("Organization owner membership insert failed.");
        }

        const [activated] = await tx
          .update(organizations)
          .set({
            status: "active",
            currentPolicyRevisionId: policyRevision.id,
            updatedAt: new Date(),
          })
          .where(eq(organizations.id, organization.id))
          .returning();
        if (!activated) {
          throw new Error("Organization activation failed.");
        }

        const result = {
          organization: toOrganizationRecord(activated),
          membership: toMembershipRecord({ membership, user: creator }),
          policyRevision: toPolicyRevisionRecord(policyRevision),
        };
        await this.insertAllowAudit(tx, input.audit, activated.id, {
          organizationSlug: activated.slug,
          policyRevisionNumber: policyRevision.revisionNumber,
          policySha256: policyRevision.policySha256,
        });
        return result;
      });
    } catch (error) {
      throw mapOrganizationPersistenceError(error, "Organization could not be created.", "ORGANIZATION_CREATE_FAILED");
    }
  }

  async listOrganizations(): Promise<OrganizationRecord[]> {
    const rows = await this.db
      .select()
      .from(organizations)
      .orderBy(desc(organizations.updatedAt), desc(organizations.id));
    return rows.map(toOrganizationRecord);
  }

  async getOrganization(organizationId: string): Promise<OrganizationRecord | null> {
    const [row] = await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return row ? toOrganizationRecord(row) : null;
  }

  async findMembership(input: {
    organizationId: string;
    userId: string;
    includeRemoved?: boolean;
  }): Promise<OrganizationMembershipRecord | null> {
    const conditions = [
      eq(organizationMemberships.organizationId, input.organizationId),
      eq(organizationMemberships.userId, input.userId),
    ];
    if (!input.includeRemoved) conditions.push(isNull(organizationMemberships.removedAt));
    const [row] = await this.db
      .select({ membership: organizationMemberships, user: userIdentitySelection() })
      .from(organizationMemberships)
      .innerJoin(users, eq(users.id, organizationMemberships.userId))
      .where(and(...conditions))
      .limit(1);
    return row ? toMembershipRecord(row) : null;
  }

  async listMemberships(input: {
    organizationId: string;
    includeRemoved?: boolean;
  }): Promise<OrganizationMembershipRecord[]> {
    const conditions = [eq(organizationMemberships.organizationId, input.organizationId)];
    if (!input.includeRemoved) conditions.push(isNull(organizationMemberships.removedAt));
    const rows = await this.db
      .select({ membership: organizationMemberships, user: userIdentitySelection() })
      .from(organizationMemberships)
      .innerJoin(users, eq(users.id, organizationMemberships.userId))
      .where(and(...conditions))
      .orderBy(asc(users.normalizedEmail), asc(users.id));
    return rows.map(toMembershipRecord);
  }

  async listInvitations(input: { organizationId: string }): Promise<OrganizationInvitationRecord[]> {
    const rows = await this.db
      .select({ invitation: organizationInvitations, organizationName: organizations.name })
      .from(organizationInvitations)
      .innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
      .where(eq(organizationInvitations.organizationId, input.organizationId))
      .orderBy(desc(organizationInvitations.createdAt), desc(organizationInvitations.id));
    return rows.map(toInvitationRecord);
  }

  async listInvitationsForEmail(normalizedEmail: string): Promise<OrganizationInvitationRecord[]> {
    const rows = await this.db
      .select({ invitation: organizationInvitations, organizationName: organizations.name })
      .from(organizationInvitations)
      .innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
      .where(and(
        eq(organizationInvitations.normalizedEmail, normalizeEmail(normalizedEmail)),
        eq(organizationInvitations.status, "pending"),
      ))
      .orderBy(desc(organizationInvitations.createdAt), desc(organizationInvitations.id));
    return rows.map(toInvitationRecord);
  }

  async createInvitation(input: {
    organizationId: string;
    email: string;
    normalizedEmail: string;
    role: OrganizationMembershipRole;
    invitedByUserId: string;
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationInvitationRecord> {
    try {
      return await this.db.transaction(async (tx) => {
        const organization = await lockOrganization(tx, input.organizationId);
        if (!organization) {
          throw new AppError("Organization not found.", "ORGANIZATION_NOT_FOUND", 404);
        }
        if (organization.status !== "active") {
          throw new AppError("Organization is not active.", "ORGANIZATION_INACTIVE", 409);
        }
        await currentOrganizationPolicy(tx, organization);

        const [inviterMembership] = await tx
          .select({
            id: organizationMemberships.id,
            role: organizationMemberships.role,
            userStatus: users.status,
          })
          .from(organizationMemberships)
          .innerJoin(users, eq(users.id, organizationMemberships.userId))
          .where(and(
            eq(organizationMemberships.organizationId, input.organizationId),
            eq(organizationMemberships.userId, input.invitedByUserId),
            isNull(organizationMemberships.removedAt),
            sql`${organizationMemberships.role} in ('owner', 'admin')`,
          ))
          .for("update")
          .limit(1);
        if (!inviterMembership || inviterMembership.userStatus !== "active") {
          throw new AppError("Organization admin access is required.", "ORGANIZATION_ADMIN_REQUIRED", 403);
        }
        if (input.role === "owner" && inviterMembership.role !== "owner") {
          throw new AppError("Organization owner access is required.", "ORGANIZATION_OWNER_REQUIRED", 403);
        }

        const normalizedEmail = normalizeEmail(input.normalizedEmail);
        const [existingMember] = await tx
          .select({ id: organizationMemberships.id })
          .from(organizationMemberships)
          .innerJoin(users, eq(users.id, organizationMemberships.userId))
          .where(and(
            eq(organizationMemberships.organizationId, input.organizationId),
            eq(users.normalizedEmail, normalizedEmail),
            isNull(organizationMemberships.removedAt),
          ))
          .limit(1);
        if (existingMember) {
          throw new AppError(
            "User is already an organization member.",
            "ORGANIZATION_MEMBER_EXISTS",
            409,
          );
        }

        const [invitation] = await tx
          .insert(organizationInvitations)
          .values({
            organizationId: input.organizationId,
            email: input.email,
            normalizedEmail,
            role: input.role,
            status: "pending",
            invitedByUserId: input.invitedByUserId,
            acceptedByUserId: null,
            acceptedAt: null,
            updatedAt: new Date(),
        })
          .returning();
        if (!invitation) throw new Error("Organization invitation insert failed.");
        await this.insertAllowAudit(tx, input.audit, organization.id);
        return toInvitationRecord({ invitation, organizationName: organization.name });
      });
    } catch (error) {
      throw mapOrganizationPersistenceError(error, "Organization invitation could not be created.", "ORGANIZATION_INVITATION_FAILED");
    }
  }

  async acceptInvitation(input: {
    invitationId: string;
    userId: string;
    email: string;
    name: string;
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationInvitationRecord | null> {
    try {
      return await this.db.transaction(async (tx) => {
        // Resolve the parent ID without taking a row lock. Every organization
        // membership/lifecycle mutation locks the organization aggregate first;
        // taking the invitation lock before that row would invert the order and
        // can deadlock against archive/role/removal requests.
        const [invitationLookup] = await tx
          .select({
            invitationId: organizationInvitations.id,
            organizationId: organizationInvitations.organizationId,
          })
          .from(organizationInvitations)
          .where(eq(organizationInvitations.id, input.invitationId))
          .limit(1);
        if (!invitationLookup) return null;

        // All membership mutations lock the organization first, then the
        // membership row. This matches role/removal operations and prevents
        // concurrent acceptance from creating duplicate active state.
        const organization = await lockOrganization(tx, invitationLookup.organizationId);
        if (!organization || organization.status !== "active") return null;
        const policy = await currentOrganizationPolicy(tx, organization);

        const [invitationRow] = await tx
          .select({ invitation: organizationInvitations })
          .from(organizationInvitations)
          .where(and(
            eq(organizationInvitations.id, invitationLookup.invitationId),
            eq(organizationInvitations.organizationId, organization.id),
            eq(organizationInvitations.status, "pending"),
          ))
          .for("update")
          .limit(1);
        if (!invitationRow) return null;

        // Resolve the accepting identity after the aggregate lock. The
        // request's email and name are not trusted as membership profile data;
        // both the invitation and the users row must agree on normalized email.
        const normalizedEmail = normalizeEmail(input.email);
        if (normalizedEmail !== invitationRow.invitation.normalizedEmail) return null;
        const [user] = await tx
          .select({ ...userIdentitySelection(), status: users.status })
          .from(users)
          .where(and(
            eq(users.id, input.userId),
            eq(users.normalizedEmail, invitationRow.invitation.normalizedEmail),
          ))
          .for("update")
          .limit(1);
        if (!user || user.status !== "active") return null;

        const [existing] = await tx
          .select()
          .from(organizationMemberships)
          .where(and(
            eq(organizationMemberships.organizationId, invitationRow.invitation.organizationId),
            eq(organizationMemberships.userId, user.id),
          ))
          .for("update")
          .limit(1);

        if (existing?.removedAt === null) {
          // Acceptance is idempotent for an already-active membership. Never
          // use a duplicate invitation to change the member's role.
        } else if (existing) {
          await assertOrganizationMemberCapacity(tx, organization.id, policy.limits.membersPerOrganization);
          await tx
            .update(organizationMemberships)
            .set({
              role: invitationRow.invitation.role,
              removedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(organizationMemberships.id, existing.id));
        } else {
          await assertOrganizationMemberCapacity(tx, organization.id, policy.limits.membersPerOrganization);
          await tx.insert(organizationMemberships).values({
            organizationId: invitationRow.invitation.organizationId,
            userId: user.id,
            role: invitationRow.invitation.role,
            invitedByUserId: invitationRow.invitation.invitedByUserId,
            removedAt: null,
          });
        }

        const now = new Date();
        const [accepted] = await tx
          .update(organizationInvitations)
          .set({
            status: "accepted",
            acceptedByUserId: user.id,
            acceptedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(organizationInvitations.id, invitationRow.invitation.id),
            eq(organizationInvitations.status, "pending"),
          ))
          .returning();
        if (!accepted) return null;
        const result = toInvitationRecord({ invitation: accepted, organizationName: organization.name });
        await this.insertAllowAudit(tx, input.audit, organization.id, { invitationId: accepted.id });
        return result;
      });
    } catch (error) {
      throw mapOrganizationPersistenceError(error, "Organization invitation could not be accepted.", "ORGANIZATION_INVITATION_ACCEPT_FAILED");
    }
  }

  async updateMembershipRole(input: {
    organizationId: string;
    userId: string;
    role: OrganizationMembershipRole;
    actorUserId: string;
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationMembershipRecord | null> {
    try {
      return await this.db.transaction(async (tx) => {
        const organization = await lockOrganization(tx, input.organizationId);
        if (!organization) return null;
        if (organization.status !== "active") {
          throw new AppError("Organization is not active.", "ORGANIZATION_INACTIVE", 409);
        }
        await currentOrganizationPolicy(tx, organization);
        const actorRole = await assertOrganizationRole(tx, input.organizationId, input.actorUserId, "admin");
        const [membership] = await tx
          .select()
          .from(organizationMemberships)
          .where(and(
            eq(organizationMemberships.organizationId, input.organizationId),
            eq(organizationMemberships.userId, input.userId),
            isNull(organizationMemberships.removedAt),
          ))
          .for("update")
          .limit(1);
        if (!membership) return null;
        if (actorRole === "admin" && (membership.role === "owner" || input.role === "owner")) {
          throw new AppError("Organization owner access is required.", "ORGANIZATION_OWNER_REQUIRED", 403);
        }
        if (membership.role === "owner" && input.role !== "owner" && await activeOwnerCount(tx, input.organizationId) <= 1) {
          throw new AppError(
            "At least one active organization owner is required.",
            "LAST_ORGANIZATION_OWNER_REQUIRED",
            409,
          );
        }
        const [updated] = await tx
          .update(organizationMemberships)
          .set({ role: input.role, updatedAt: new Date() })
          .where(eq(organizationMemberships.id, membership.id))
          .returning();
        if (!updated) return null;
        const result = await membershipWithUser(tx, updated);
        if (!result) return null;
        await this.insertAllowAudit(tx, input.audit, input.organizationId, {
          memberId: result.userId,
          roleBefore: membership.role,
          roleAfter: result.role,
        });
        return result;
      });
    } catch (error) {
      throw mapOrganizationPersistenceError(error, "Organization member role could not be updated.", "ORGANIZATION_MEMBER_ROLE_UPDATE_FAILED");
    }
  }

  async removeMembership(input: {
    organizationId: string;
    userId: string;
    actorUserId: string;
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationMembershipRecord | null> {
    try {
      return await this.db.transaction(async (tx) => {
        const organization = await lockOrganization(tx, input.organizationId);
        if (!organization) return null;
        if (organization.status !== "active") {
          throw new AppError("Organization is not active.", "ORGANIZATION_INACTIVE", 409);
        }
        await currentOrganizationPolicy(tx, organization);
        const actorRole = await assertOrganizationRole(tx, input.organizationId, input.actorUserId, "admin");
        const [membership] = await tx
          .select()
          .from(organizationMemberships)
          .where(and(
            eq(organizationMemberships.organizationId, input.organizationId),
            eq(organizationMemberships.userId, input.userId),
            isNull(organizationMemberships.removedAt),
          ))
          .for("update")
          .limit(1);
        if (!membership) return null;
        if (actorRole === "admin" && membership.role === "owner") {
          throw new AppError("Organization owner access is required.", "ORGANIZATION_OWNER_REQUIRED", 403);
        }
        if (membership.role === "owner" && await activeOwnerCount(tx, input.organizationId) <= 1) {
          throw new AppError(
            "At least one active organization owner is required.",
            "LAST_ORGANIZATION_OWNER_REQUIRED",
            409,
          );
        }
        const now = new Date();
        const [removed] = await tx
          .update(organizationMemberships)
          .set({ removedAt: now, updatedAt: now })
          .where(eq(organizationMemberships.id, membership.id))
          .returning();
        if (!removed) return null;
        const result = await membershipWithUser(tx, removed);
        if (!result) return null;
        await this.insertAllowAudit(tx, input.audit, input.organizationId, {
          memberId: result.userId,
          roleBefore: membership.role,
        });
        return result;
      });
    } catch (error) {
      throw mapOrganizationPersistenceError(error, "Organization member could not be removed.", "ORGANIZATION_MEMBER_REMOVE_FAILED");
    }
  }

  async listPolicyRevisions(organizationId: string): Promise<OrganizationPolicyRevision[]> {
    const rows = await this.db
      .select()
      .from(organizationPolicyRevisions)
      .where(eq(organizationPolicyRevisions.organizationId, organizationId))
      .orderBy(desc(organizationPolicyRevisions.revisionNumber), desc(organizationPolicyRevisions.id));
    return rows.map(toPolicyRevisionRecord);
  }

  async getPolicyRevision(input: {
    organizationId: string;
    revisionId?: string;
  }): Promise<OrganizationPolicyRevision | null> {
    const conditions = [eq(organizationPolicyRevisions.organizationId, input.organizationId)];
    if (input.revisionId) conditions.push(eq(organizationPolicyRevisions.id, input.revisionId));
    const [row] = await this.db
      .select()
      .from(organizationPolicyRevisions)
      .where(and(...conditions))
      .orderBy(desc(organizationPolicyRevisions.revisionNumber))
      .limit(1);
    return row ? toPolicyRevisionRecord(row) : null;
  }

  async appendPolicyRevision(input: {
    organizationId: string;
    policy: OrganizationPolicyV1;
    policySha256: string;
    reason: string;
    createdByUserId: string;
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationPolicyAppendResult> {
    assertPolicyDigest(input.policy, input.policySha256);

    try {
      return await this.db.transaction(async (tx) => {
        const organization = await lockOrganization(tx, input.organizationId);
        if (!organization) {
          throw new AppError("Organization not found.", "ORGANIZATION_NOT_FOUND", 404);
        }
        if (organization.status !== "active") {
          throw new AppError("Organization is not active.", "ORGANIZATION_INACTIVE", 409);
        }
        await assertOrganizationOwner(tx, input.organizationId, input.createdByUserId);

        const [existing] = await tx
          .select()
          .from(organizationPolicyRevisions)
          .where(and(
            eq(organizationPolicyRevisions.organizationId, input.organizationId),
            eq(organizationPolicyRevisions.policySha256, input.policySha256),
          ))
          .limit(1);
        if (existing) {
          const [activated] = await tx
            .update(organizations)
            .set({ currentPolicyRevisionId: existing.id, updatedAt: new Date() })
            .where(eq(organizations.id, input.organizationId))
            .returning();
          if (!activated) throw new Error("Organization policy activation failed.");
          const result = { revision: toPolicyRevisionRecord(existing), created: false, activated: true };
          await this.insertAllowAudit(tx, input.audit, input.organizationId, {
            revisionNumber: result.revision.revisionNumber,
            policySha256: result.revision.policySha256,
            created: result.created,
            activated: result.activated,
          });
          return result;
        }

        const [highest] = await tx
          .select({ max: sql<number>`coalesce(max(${organizationPolicyRevisions.revisionNumber}), 0)` })
          .from(organizationPolicyRevisions)
          .where(eq(organizationPolicyRevisions.organizationId, input.organizationId));
        const [revision] = await tx
          .insert(organizationPolicyRevisions)
          .values({
            organizationId: input.organizationId,
            revisionNumber: Number(highest?.max ?? 0) + 1,
            schemaVersion: input.policy.schemaVersion,
            policy: input.policy,
            policySha256: input.policySha256,
            reason: input.reason,
            createdByUserId: input.createdByUserId,
          })
          .returning();
        if (!revision) throw new Error("Organization policy revision insert failed.");
        const [activated] = await tx
          .update(organizations)
          .set({ currentPolicyRevisionId: revision.id, updatedAt: new Date() })
          .where(eq(organizations.id, input.organizationId))
          .returning();
        if (!activated) throw new Error("Organization policy activation failed.");
        const result = { revision: toPolicyRevisionRecord(revision), created: true, activated: true };
        await this.insertAllowAudit(tx, input.audit, input.organizationId, {
          revisionNumber: result.revision.revisionNumber,
          policySha256: result.revision.policySha256,
          created: result.created,
          activated: result.activated,
        });
        return result;
      });
    } catch (error) {
      throw mapOrganizationPersistenceError(error, "Organization policy could not be activated.", "ORGANIZATION_POLICY_APPEND_FAILED");
    }
  }

  async activatePolicyRevision(input: {
    organizationId: string;
    revisionId: string;
    actorUserId: string;
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationPolicyActivationResult | null> {
    try {
      return await this.db.transaction(async (tx) => {
        // Lock the organization first. All policy-pointer mutations use this
        // lock order, so concurrent activation and append operations serialize
        // without ever rewriting an immutable revision row.
        const organization = await lockOrganization(tx, input.organizationId);
        if (!organization) return null;
        if (organization.status !== "active") {
          throw new AppError("Organization is not active.", "ORGANIZATION_INACTIVE", 409);
        }
        await assertOrganizationRole(tx, input.organizationId, input.actorUserId, "owner");

        // The composite lookup is the tenancy boundary. A revision ID from a
        // different organization is indistinguishable from a missing one.
        const [revision] = await tx
          .select()
          .from(organizationPolicyRevisions)
          .where(and(
            eq(organizationPolicyRevisions.organizationId, input.organizationId),
            eq(organizationPolicyRevisions.id, input.revisionId),
          ))
          .limit(1);
        if (!revision) return null;

        const changed = organization.currentPolicyRevisionId !== revision.id;
        if (changed) {
          const [activated] = await tx
            .update(organizations)
            .set({ currentPolicyRevisionId: revision.id, updatedAt: new Date() })
            .where(eq(organizations.id, input.organizationId))
            .returning({ id: organizations.id });
          if (!activated) throw new Error("Organization policy activation failed.");
        }
        const result = {
          revision: toPolicyRevisionRecord(revision),
          activated: true as const,
          changed,
        };
        await this.insertAllowAudit(tx, input.audit, input.organizationId, {
          revisionNumber: result.revision.revisionNumber,
          policySha256: result.revision.policySha256,
        });
        return result;
      });
    } catch (error) {
      throw mapOrganizationPersistenceError(error, "Organization policy could not be activated.", "ORGANIZATION_POLICY_ACTIVATE_FAILED");
    }
  }

  async archiveOrganization(input: {
    organizationId: string;
    actorUserId: string;
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationRecord | null> {
    try {
      return await this.db.transaction(async (tx) => {
        const organization = await lockOrganization(tx, input.organizationId);
        if (!organization) return null;
        if (organization.status !== "active") {
          throw new AppError("Organization is not active.", "ORGANIZATION_INACTIVE", 409);
        }
        await assertOrganizationRole(tx, input.organizationId, input.actorUserId, "owner");
        const [archived] = await tx
          .update(organizations)
          .set({ status: "archived", updatedAt: new Date() })
          .where(eq(organizations.id, input.organizationId))
          .returning();
        if (!archived) return null;
        const result = toOrganizationRecord(archived);
        await this.insertAllowAudit(tx, input.audit, input.organizationId, {
          previousStatus: organization.status,
          status: result.status,
        });
        return result;
      });
    } catch (error) {
      throw mapOrganizationPersistenceError(error, "Organization could not be archived.", "ORGANIZATION_ARCHIVE_FAILED");
    }
  }

  async recordAuditEvent(input: OrganizationAuditInput): Promise<void> {
    await insertOrganizationAuditEvent(this.db, input);
  }

  private async insertAllowAudit(
    db: DbLike,
    input: OrganizationAuditInput | undefined,
    resourceId: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    if (!input) return;
    const audit = {
      ...input,
      resourceId,
      details: { ...input.details, ...details },
    };
    await this.options.beforeAuditInsert?.(audit);
    await insertOrganizationAuditEvent(db, audit);
  }

  async listAuditEvents(limit = 100): Promise<OrganizationAuditEvent[]> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceType, "organization"))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(boundedLimit);
    return rows.map((event) => ({
      id: event.id,
      actorUserId: event.actorUserId ?? "",
      action: event.action,
      decision: event.decision === "allow" ? "allow" : "deny",
      resourceId: event.resourceId,
      details: auditDetails(event.details),
      createdAt: event.createdAt.toISOString(),
    }));
  }
}

function userIdentitySelection() {
  return {
    id: users.id,
    email: users.email,
    normalizedEmail: users.normalizedEmail,
    name: users.name,
  };
}

async function insertOrganizationAuditEvent(db: DbLike, input: OrganizationAuditInput): Promise<void> {
  await db.insert(auditEvents).values({
    actorUserId: isUuid(input.actorUserId) ? input.actorUserId : null,
    action: boundedString(input.action, 120),
    decision: input.decision === "allow" ? "allow" : "deny",
    resourceType: "organization",
    resourceId: input.resourceId && isUuid(input.resourceId) ? input.resourceId : null,
    details: sanitizeAuditDetails(input.details ?? {}),
  });
}

type UserIdentity = {
  id: string;
  email: string;
  normalizedEmail: string;
  name: string;
};

async function membershipWithUser(
  db: DbLike,
  membership: typeof organizationMemberships.$inferSelect,
): Promise<OrganizationMembershipRecord | null> {
  const [user] = await db
    .select(userIdentitySelection())
    .from(users)
    .where(eq(users.id, membership.userId))
    .limit(1);
  return user ? toMembershipRecord({ membership, user }) : null;
}

async function lockOrganization(
  db: DbLike,
  organizationId: string,
): Promise<typeof organizations.$inferSelect | null> {
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update")
    .limit(1);
  return organization ?? null;
}

async function currentOrganizationPolicy(
  db: DbLike,
  organization: typeof organizations.$inferSelect,
): Promise<OrganizationPolicyV1> {
  if (!organization.currentPolicyRevisionId) {
    throw new AppError("Organization policy is unavailable.", "ORGANIZATION_POLICY_UNAVAILABLE", 500);
  }
  const [revision] = await db
    .select({
      id: organizationPolicyRevisions.id,
      organizationId: organizationPolicyRevisions.organizationId,
      policy: organizationPolicyRevisions.policy,
      policySha256: organizationPolicyRevisions.policySha256,
    })
    .from(organizationPolicyRevisions)
    .where(and(
      eq(organizationPolicyRevisions.organizationId, organization.id),
      eq(organizationPolicyRevisions.id, organization.currentPolicyRevisionId),
    ))
    .limit(1);
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

async function assertOrganizationRole(
  db: DbLike,
  organizationId: string,
  userId: string,
  minimum: "admin" | "owner",
): Promise<OrganizationMembershipRole> {
  const [membership] = await db
    .select({ role: organizationMemberships.role, userStatus: users.status })
    .from(organizationMemberships)
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .where(and(
      eq(organizationMemberships.organizationId, organizationId),
      eq(organizationMemberships.userId, userId),
      isNull(organizationMemberships.removedAt),
    ))
    .for("update")
    .limit(1);
  const allowed = membership && membership.userStatus === "active" && (minimum === "owner"
    ? membership.role === "owner"
    : membership.role === "owner" || membership.role === "admin");
  if (!allowed) {
    throw new AppError(
      minimum === "owner" ? "Organization owner access is required." : "Organization admin access is required.",
      minimum === "owner" ? "ORGANIZATION_OWNER_REQUIRED" : "ORGANIZATION_ADMIN_REQUIRED",
      403,
    );
  }
  return membership.role as OrganizationMembershipRole;
}

async function assertOrganizationOwner(db: DbLike, organizationId: string, userId: string): Promise<void> {
  await assertOrganizationRole(db, organizationId, userId, "owner");
}

async function assertOrganizationMemberCapacity(
  db: DbLike,
  organizationId: string,
  limit: number,
): Promise<void> {
  // The organization row is locked by every membership mutation in this
  // store. Counting after that lock makes acceptance/reactivation atomic with
  // removals and prevents two requests from exceeding the active-member cap.
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(organizationMemberships)
    .where(and(
      eq(organizationMemberships.organizationId, organizationId),
      isNull(organizationMemberships.removedAt),
    ));
  if (Number(count ?? 0) >= limit) {
    throw new AppError(
      "Organization member limit has been reached.",
      "ORGANIZATION_MEMBER_LIMIT_REACHED",
      409,
      { limit },
    );
  }
}

async function activeOwnerCount(db: DbLike, organizationId: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(organizationMemberships)
    .where(and(
      eq(organizationMemberships.organizationId, organizationId),
      eq(organizationMemberships.role, "owner"),
      isNull(organizationMemberships.removedAt),
    ));
  return Number(count ?? 0);
}

function toOrganizationRecord(row: typeof organizations.$inferSelect): OrganizationRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status as OrganizationStatus,
    currentPolicyRevisionId: row.currentPolicyRevisionId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMembershipRecord(input: {
  membership: typeof organizationMemberships.$inferSelect;
  user: UserIdentity;
}): OrganizationMembershipRecord {
  return {
    id: input.membership.id,
    organizationId: input.membership.organizationId,
    userId: input.membership.userId,
    email: input.user.email,
    name: input.user.name,
    role: input.membership.role as OrganizationMembershipRole,
    invitedByUserId: input.membership.invitedByUserId,
    removedAt: input.membership.removedAt?.toISOString() ?? null,
    createdAt: input.membership.createdAt.toISOString(),
    updatedAt: input.membership.updatedAt.toISOString(),
  };
}

function toInvitationRecord(input: {
  invitation: typeof organizationInvitations.$inferSelect;
  organizationName: string;
}): OrganizationInvitationRecord {
  return {
    id: input.invitation.id,
    organizationId: input.invitation.organizationId,
    organizationName: input.organizationName,
    email: input.invitation.email,
    normalizedEmail: input.invitation.normalizedEmail,
    role: input.invitation.role as OrganizationMembershipRole,
    status: input.invitation.status,
    invitedByUserId: input.invitation.invitedByUserId,
    acceptedByUserId: input.invitation.acceptedByUserId,
    acceptedAt: input.invitation.acceptedAt?.toISOString() ?? null,
    createdAt: input.invitation.createdAt.toISOString(),
    updatedAt: input.invitation.updatedAt.toISOString(),
  };
}

function toPolicyRevisionRecord(row: typeof organizationPolicyRevisions.$inferSelect): OrganizationPolicyRevision {
  let policy: OrganizationPolicyV1;
  try {
    policy = normalizeOrganizationPolicyV1(row.policy);
  } catch (error) {
    throw new AppError(
      "Persisted organization policy is invalid.",
      "PERSISTED_ORGANIZATION_POLICY_INVALID",
      500,
      error instanceof Error ? { cause: error.message } : undefined,
    );
  }
  if (organizationPolicyDigest(policy) !== row.policySha256) {
    throw new AppError(
      "Persisted organization policy digest is invalid.",
      "PERSISTED_ORGANIZATION_POLICY_INVALID",
      500,
    );
  }
  return {
    id: row.id,
    organizationId: row.organizationId,
    revisionNumber: row.revisionNumber,
    policy,
    policySha256: row.policySha256,
    reason: row.reason,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapOrganizationPersistenceError(error: unknown, fallbackMessage: string, fallbackCode: string): AppError {
  if (error instanceof AppError) return error;
  const pgError = findPgError(error);
  if (pgError) {
    if (pgError.code === "23505") {
      if (pgError.constraint?.includes("organization_invitations")) {
        return new AppError("Organization invitation already exists.", "ORGANIZATION_INVITATION_EXISTS", 409);
      }
      if (pgError.constraint?.includes("organization_memberships")) {
        return new AppError("User is already an organization member.", "ORGANIZATION_MEMBER_EXISTS", 409);
      }
      if (pgError.constraint?.includes("organization_policy_revisions")) {
        return new AppError("Organization policy revision already exists.", "ORGANIZATION_POLICY_ALREADY_EXISTS", 409);
      }
      if (pgError.constraint?.includes("organizations")) {
        return new AppError("Organization name is already in use.", "ORGANIZATION_ALREADY_EXISTS", 409);
      }
    }
    if (pgError.code === "23503") {
      return new AppError("Organization reference was not found.", "ORGANIZATION_REFERENCE_NOT_FOUND", 404);
    }
    if (pgError.code === "23514") {
      return new AppError("Organization data is invalid.", "INVALID_ORGANIZATION_DATA", 400);
    }
  }
  return new AppError(
    fallbackMessage,
    fallbackCode,
    409,
    error instanceof Error ? { cause: error.message } : undefined,
  );
}

function auditDetails(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function assertPolicyDigest(policy: OrganizationPolicyV1, expectedDigest: string): void {
  let digest: string;
  try {
    digest = organizationPolicyDigest(policy);
  } catch (error) {
    throw new AppError(
      "Organization policy is invalid.",
      "INVALID_ORGANIZATION_POLICY",
      400,
      error instanceof Error ? { cause: error.message } : undefined,
    );
  }
  if (digest !== expectedDigest) {
    throw new AppError(
      "Organization policy digest is invalid.",
      "ORGANIZATION_POLICY_DIGEST_INVALID",
      400,
    );
  }
}

function boundedString(value: string, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPgError(value: unknown): value is { code: string; constraint?: string } {
  return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string";
}

function findPgError(value: unknown): { code: string; constraint?: string } | null {
  if (isPgError(value)) return value;
  if (value instanceof Error && "cause" in value) return findPgError(value.cause);
  return null;
}
