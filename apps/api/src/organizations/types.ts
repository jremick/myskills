import type {
  OrganizationMembershipRole,
  OrganizationPolicyRevision,
  OrganizationPolicyV1,
  OrganizationPolicyV1Input,
  OrganizationStatus,
} from "@myskills-app/core";
import type { TeamActor, TeamRecord } from "../teams/types.js";

export type {
  OrganizationMembershipRole,
  OrganizationPolicyRevision,
  OrganizationPolicyV1,
  OrganizationPolicyV1Input,
  OrganizationStatus,
} from "@myskills-app/core";

/** Identity information needed by the application service. */
export interface OrganizationActor {
  id: string;
  email: string;
  name?: string;
}

/** The persisted organization row. Policy contents live in immutable revisions. */
export interface OrganizationRecord {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  currentPolicyRevisionId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMembershipRecord {
  id: string;
  organizationId: string;
  userId: string;
  email: string;
  name: string;
  role: OrganizationMembershipRole;
  invitedByUserId: string | null;
  removedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type OrganizationInvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface OrganizationInvitationRecord {
  id: string;
  organizationId: string;
  organizationName: string;
  email: string;
  normalizedEmail: string;
  role: OrganizationMembershipRole;
  status: OrganizationInvitationStatus;
  invitedByUserId: string | null;
  acceptedByUserId: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationListItem extends OrganizationRecord {
  role: OrganizationMembershipRole;
}

export interface OrganizationDetail extends OrganizationListItem {
  currentPolicy: OrganizationPolicyRevision | null;
}

export interface OrganizationCreatedResult {
  organization: OrganizationRecord;
  membership: OrganizationMembershipRecord;
  policyRevision: OrganizationPolicyRevision;
}

export interface CreateOrganizationStoreInput {
  id?: string;
  name: string;
  slug: string;
  createdByUserId: string;
  creatorEmail: string;
  creatorName: string;
  policy: OrganizationPolicyV1;
  policySha256: string;
  reason: string;
  /** Required by service calls; persisted with the aggregate transaction. */
  audit?: OrganizationAuditInput;
}

export interface CreateOrganizationInput {
  actor: OrganizationActor;
  name: string;
  slug?: string;
  policy?: OrganizationPolicyV1Input | OrganizationPolicyV1;
  reason?: string;
}

export interface InviteOrganizationMemberInput {
  actor: OrganizationActor;
  organizationId: string;
  email: string;
  role?: OrganizationMembershipRole;
}

export interface AcceptOrganizationInvitationInput {
  actor: OrganizationActor;
  invitationId: string;
}

export interface UpdateOrganizationMemberRoleInput {
  actor: OrganizationActor;
  organizationId: string;
  memberId: string;
  role: OrganizationMembershipRole;
}

export interface RemoveOrganizationMemberInput {
  actor: OrganizationActor;
  organizationId: string;
  memberId: string;
}

export interface AppendOrganizationPolicyInput {
  actor: OrganizationActor;
  organizationId: string;
  policy: OrganizationPolicyV1Input | OrganizationPolicyV1;
  reason?: string;
}

export interface OrganizationPolicyAppendResult {
  revision: OrganizationPolicyRevision;
  created: boolean;
  activated: boolean;
}

export interface ActivateOrganizationPolicyInput {
  actor: OrganizationActor;
  organizationId: string;
  revisionId: string;
}

/** Result of moving the current pointer to an existing immutable revision. */
export interface OrganizationPolicyActivationResult {
  revision: OrganizationPolicyRevision;
  activated: true;
  changed: boolean;
}

export interface ArchiveOrganizationInput {
  actor: OrganizationActor;
  organizationId: string;
}

export interface CreateChildTeamInput {
  actor: OrganizationActor;
  organizationId: string;
  name: string;
  slug?: string;
}

export interface AdoptStandaloneTeamInput {
  actor: OrganizationActor;
  organizationId: string;
  teamId: string;
}

/**
 * Deliberately narrow dependency from organization orchestration to teams.
 * Organization policy and membership authorization stay in this service;
 * the team service/store owns the atomic team mutation and team membership
 * checks.
 */
export interface OrganizationTeamPort {
  createChildTeam(input: {
    actor: TeamActor;
    organizationId: string;
    name: string;
    slug?: string;
  }): Promise<TeamRecord>;
  adoptStandaloneTeam(input: {
    actor: TeamActor;
    organizationId: string;
    teamId: string;
  }): Promise<TeamRecord>;
}

export interface OrganizationAuditInput {
  actorUserId: string;
  action: string;
  decision: "allow" | "deny";
  resourceId?: string | null;
  details?: Record<string, unknown>;
}

export interface OrganizationAuditEvent extends OrganizationAuditInput {
  id: string;
  resourceId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface OrganizationStore {
  readonly kind: "memory" | "postgres";

  /** Create the organization, owner membership, and policy revision atomically. */
  createOrganization(input: CreateOrganizationStoreInput): Promise<OrganizationCreatedResult>;
  listOrganizations(): Promise<OrganizationRecord[]>;
  getOrganization(organizationId: string): Promise<OrganizationRecord | null>;

  findMembership(input: {
    organizationId: string;
    userId: string;
    includeRemoved?: boolean;
  }): Promise<OrganizationMembershipRecord | null>;
  listMemberships(input: { organizationId: string; includeRemoved?: boolean }): Promise<OrganizationMembershipRecord[]>;
  listInvitations(input: { organizationId: string }): Promise<OrganizationInvitationRecord[]>;
  listInvitationsForEmail(normalizedEmail: string): Promise<OrganizationInvitationRecord[]>;

  createInvitation(input: {
    organizationId: string;
    email: string;
    normalizedEmail: string;
    role: OrganizationMembershipRole;
    invitedByUserId: string;
    /** Persisted with the invitation transaction when supplied. */
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationInvitationRecord>;
  acceptInvitation(input: {
    invitationId: string;
    userId: string;
    email: string;
    name: string;
    /** Persisted with the acceptance transaction when supplied. */
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationInvitationRecord | null>;
  updateMembershipRole(input: {
    organizationId: string;
    userId: string;
    role: OrganizationMembershipRole;
    /** Server-authenticated actor rechecked inside the mutation boundary. */
    actorUserId: string;
    /** Persisted with the membership transaction when supplied. */
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationMembershipRecord | null>;
  removeMembership(input: {
    organizationId: string;
    userId: string;
    /** Server-authenticated actor rechecked inside the mutation boundary. */
    actorUserId: string;
    /** Persisted with the membership transaction when supplied. */
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationMembershipRecord | null>;

  listPolicyRevisions(organizationId: string): Promise<OrganizationPolicyRevision[]>;
  getPolicyRevision(input: { organizationId: string; revisionId?: string }): Promise<OrganizationPolicyRevision | null>;
  appendPolicyRevision(input: {
    organizationId: string;
    policy: OrganizationPolicyV1;
    policySha256: string;
    reason: string;
    createdByUserId: string;
    /** Persisted with the policy transaction when supplied. */
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationPolicyAppendResult>;
  activatePolicyRevision(input: {
    organizationId: string;
    revisionId: string;
    /** Server-authenticated owner rechecked inside the mutation boundary. */
    actorUserId: string;
    /** Persisted with the policy transaction when supplied. */
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationPolicyActivationResult | null>;
  archiveOrganization(input: {
    organizationId: string;
    /** Server-authenticated owner rechecked inside the mutation boundary. */
    actorUserId: string;
    /** Persisted with the archive transaction when supplied. */
    audit?: OrganizationAuditInput;
  }): Promise<OrganizationRecord | null>;

  recordAuditEvent(input: OrganizationAuditInput): Promise<void>;
  listAuditEvents(limit?: number): Promise<OrganizationAuditEvent[]>;
}
