import { randomUUID } from "node:crypto";
import {
  AppError,
  assertValidOrganizationPolicyV1,
  defaultOrganizationPolicyV1,
  type ArchitectureOrganizationGrantContext,
  type ArchitectureOrganizationMembership,
  type OrganizationMembershipRole,
  type OrganizationPolicyV1,
  type OrganizationStatus,
} from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import {
  architectureAccessForRecord,
  evaluateArchitectureAccess,
  normalizeArchitectureActor,
  normalizeOwnerReference,
  type ArchitectureAccessMetadata,
  type ArchitectureActorInput,
  type ArchitectureAuditEvent,
  type ArchitectureAuditInput,
  type ArchitectureMembershipStore,
  type ArchitectureRecord,
  type ArchitectureRevisionRecord,
  type ArchitectureStore,
  type ArchitectureTeamMemberRole,
  type CreateArchitectureInput,
  type CreateArchitectureRevisionInput,
} from "./types.js";
import {
  assertArchitectureSpecSize,
  MAX_ARCHITECTURES_PER_OWNER,
  MAX_VISIBLE_ARCHITECTURES,
  MAX_REVISIONS_PER_ARCHITECTURE,
  validateArchitectureSpec,
} from "./service.js";
import { evaluateArchitectureRevisionAuthorizationIntent } from "./revision-authorization.js";

export interface MemoryArchitectureMembership {
  userId?: string;
  actorId?: string;
  teamId: string;
  role: ArchitectureTeamMemberRole;
  /** Parent organization for an org-owned team; omitted means standalone. */
  organizationId?: string | null;
}

export interface MemoryArchitectureOrganization {
  id: string;
  status?: OrganizationStatus;
  currentPolicyRevisionId?: string | null;
  policy?: OrganizationPolicyV1;
}

export interface MemoryArchitectureOrganizationPolicyRevision {
  id: string;
  organizationId: string;
  policy: OrganizationPolicyV1;
}

export interface MemoryArchitectureOrganizationMembership {
  userId?: string;
  actorId?: string;
  organizationId: string;
  role: OrganizationMembershipRole;
  /** A non-null removal marker is excluded from the current snapshot. */
  removedAt?: string | null;
}

export interface MemoryArchitectureOrganizationGrant {
  architectureId: string;
  organizationId: string;
  policyRevisionId?: string | null;
  createdUnderPolicyRevisionId?: string | null;
  accessLevel?: "read";
}

export interface MemoryArchitectureStoreOptions {
  /** Seed memberships when a standalone memory store is used in tests. */
  teamMemberships?: readonly MemoryArchitectureMembership[];
  /** Alias retained for callers that use the shorter option name. */
  memberships?: readonly MemoryArchitectureMembership[];
  /** Existing team store can be used as the membership authority. */
  teamStore?: ArchitectureMembershipStore;
  /** Instance-wide organization visibility switch; secure default is false. */
  organizationVisibilityEnabled?: boolean;
  /** Organization rows and current policy pointers used by focused fixtures. */
  organizations?: readonly MemoryArchitectureOrganization[];
  /** Current active organization membership rows. */
  organizationMemberships?: readonly MemoryArchitectureOrganizationMembership[];
  /** Immutable organization policy revisions. */
  organizationPolicyRevisions?: readonly MemoryArchitectureOrganizationPolicyRevision[];
  /** Alias retained for fixtures that call the rows organization policies. */
  organizationPolicies?: readonly MemoryArchitectureOrganizationPolicyRevision[];
  /** Exact architecture-to-organization grant rows. */
  organizationGrants?: readonly MemoryArchitectureOrganizationGrant[];
  /** Test-only failure injection before an architecture and allow audit commit. */
  beforeCommit?: (input: ArchitectureAuditInput) => void | Promise<void>;
}

interface MemoryArchitectureOrganizationPolicy {
  id: string;
  organizationId: string;
  policy: OrganizationPolicyV1;
}

interface MemoryArchitecture extends ArchitectureRecord {
  revisions: ArchitectureRevisionRecord[];
}

export class MemoryArchitectureStore implements ArchitectureStore {
  readonly kind = "memory" as const;
  private readonly architectures = new Map<string, MemoryArchitecture>();
  private readonly auditEvents: ArchitectureAuditEvent[] = [];
  private readonly memberships = new Map<string, Map<string, ArchitectureTeamMemberRole>>();
  private readonly teamOrganizationIds = new Map<string, string | null>();
  private readonly organizations = new Map<string, MemoryArchitectureOrganization & { status: OrganizationStatus; currentPolicyRevisionId: string | null }>();
  private readonly organizationPolicies = new Map<string, MemoryArchitectureOrganizationPolicy>();
  private readonly organizationMemberships = new Map<string, Map<string, ArchitectureOrganizationMembership["role"]>>();
  private readonly organizationGrants = new Map<string, Map<string, { policyRevisionId: string | null; accessLevel: "read" }>>();
  private readonly teamStore?: ArchitectureMembershipStore;
  private organizationVisibilityEnabled: boolean;
  private readonly beforeCommit?: (input: ArchitectureAuditInput) => void | Promise<void>;

  constructor(options: MemoryArchitectureStoreOptions = {}) {
    this.teamStore = options.teamStore;
    this.organizationVisibilityEnabled = options.organizationVisibilityEnabled ?? false;
    this.beforeCommit = options.beforeCommit;
    for (const membership of [...(options.teamMemberships ?? []), ...(options.memberships ?? [])]) {
      const actorId = membership.userId ?? membership.actorId;
      if (actorId) this.setTeamMembership(actorId, membership.teamId, membership.role, membership.organizationId);
    }
    for (const organization of options.organizations ?? []) this.addOrganization(organization);
    for (const policy of [...(options.organizationPolicyRevisions ?? []), ...(options.organizationPolicies ?? [])]) {
      this.addOrganizationPolicyRevision(policy);
    }
    for (const membership of options.organizationMemberships ?? []) {
      const actorId = membership.userId ?? membership.actorId;
      if (actorId && !membership.removedAt) {
        this.addOrganizationMembership(actorId, membership.organizationId, membership.role);
      }
    }
    for (const grant of options.organizationGrants ?? []) this.addOrganizationGrant(grant);
  }

  /** Add or replace a membership in a deterministic memory test fixture. */
  setTeamMembership(actorId: string, teamId: string, role: ArchitectureTeamMemberRole, organizationId?: string | null): void {
    const byTeam = this.memberships.get(actorId) ?? new Map<string, ArchitectureTeamMemberRole>();
    byTeam.set(teamId, role);
    this.memberships.set(actorId, byTeam);
    if (organizationId !== undefined) this.teamOrganizationIds.set(teamId, organizationId);
  }

  setTeamOrganization(teamId: string, organizationId: string | null): void {
    this.teamOrganizationIds.set(teamId, organizationId);
  }

  setOrganizationVisibilityEnabled(enabled: boolean): void {
    this.organizationVisibilityEnabled = enabled;
  }

  addOrganization(input: MemoryArchitectureOrganization): void {
    const currentPolicyRevisionId = input.currentPolicyRevisionId === undefined
      ? `${input.id}:policy:1`
      : input.currentPolicyRevisionId;
    const policy = assertValidOrganizationPolicyV1(input.policy ?? defaultOrganizationPolicyV1);
    this.organizations.set(input.id, {
      id: input.id,
      status: input.status ?? "active",
      currentPolicyRevisionId,
      policy,
    });
    if (currentPolicyRevisionId) {
      this.addOrganizationPolicyRevision({
        id: currentPolicyRevisionId,
        organizationId: input.id,
        policy,
      });
    }
  }

  setOrganizationStatus(organizationId: string, status: OrganizationStatus): void {
    const organization = this.organizations.get(organizationId);
    if (!organization) throw new AppError("Organization not found.", "ORGANIZATION_NOT_FOUND", 404);
    organization.status = status;
  }

  addOrganizationPolicyRevision(input: MemoryArchitectureOrganizationPolicyRevision): void {
    if (!this.organizations.has(input.organizationId)) {
      this.addOrganization({ id: input.organizationId, currentPolicyRevisionId: null });
    }
    this.organizationPolicies.set(input.id, {
      id: input.id,
      organizationId: input.organizationId,
      policy: assertValidOrganizationPolicyV1(input.policy),
    });
  }

  setOrganizationPolicy(organizationId: string, policy: OrganizationPolicyV1, revisionId?: string | null): void {
    const organization = this.organizations.get(organizationId);
    if (!organization) throw new AppError("Organization not found.", "ORGANIZATION_NOT_FOUND", 404);
    const nextRevisionId = revisionId ?? `${organizationId}:policy:${this.organizationPolicies.size + 1}`;
    this.addOrganizationPolicyRevision({ id: nextRevisionId, organizationId, policy });
    organization.currentPolicyRevisionId = nextRevisionId;
  }

  addOrganizationMembership(
    userId: string,
    organizationId: string,
    role: OrganizationMembershipRole,
  ): void {
    const byOrganization = this.organizationMemberships.get(userId) ?? new Map<string, ArchitectureOrganizationMembership["role"]>();
    byOrganization.set(organizationId, strongerOrganizationRole(byOrganization.get(organizationId), role));
    this.organizationMemberships.set(userId, byOrganization);
  }

  removeOrganizationMembership(userId: string, organizationId: string): void {
    this.organizationMemberships.get(userId)?.delete(organizationId);
  }

  addOrganizationGrant(input: MemoryArchitectureOrganizationGrant): void {
    const organization = this.organizations.get(input.organizationId);
    const policyRevisionId = input.policyRevisionId
      ?? input.createdUnderPolicyRevisionId
      ?? organization?.currentPolicyRevisionId
      ?? null;
    const grants = this.organizationGrants.get(input.architectureId) ?? new Map<string, { policyRevisionId: string | null; accessLevel: "read" }>();
    grants.set(input.organizationId, {
      policyRevisionId,
      accessLevel: input.accessLevel ?? "read",
    });
    this.organizationGrants.set(input.architectureId, grants);
  }

  removeOrganizationGrant(architectureId: string, organizationId: string): void {
    this.organizationGrants.get(architectureId)?.delete(organizationId);
  }

  async listArchitectures(actorInput: ArchitectureActorInput): Promise<ArchitectureRecord[]> {
    const actor = await this.resolveActor(actorInput);
    return [...this.architectures.values()]
      .filter((architecture) => this.accessForArchitecture(actor, architecture).canRead)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      .slice(0, MAX_VISIBLE_ARCHITECTURES)
      .map((architecture) => this.stripRevisions(architecture, actor));
  }

  async getArchitecture(actorInput: ArchitectureActorInput, architectureId: string): Promise<ArchitectureRecord | null> {
    const actor = await this.resolveActor(actorInput);
    const architecture = this.architectures.get(architectureId);
    if (!architecture || !this.accessForArchitecture(actor, architecture).canRead) return null;
    return this.stripRevisions(architecture, actor);
  }

  async listRevisions(actorInput: ArchitectureActorInput, architectureId: string): Promise<ArchitectureRevisionRecord[] | null> {
    const actor = await this.resolveActor(actorInput);
    const architecture = this.architectures.get(architectureId);
    if (!architecture) return null;
    const access = this.accessForArchitecture(actor, architecture);
    if (!access.canRead) return null;
    return architecture.revisions
      .filter((revision) => revisionSpecReadableToActor(revision.spec, access))
      .map((revision) => this.cloneRevision(revision, architecture, actor))
      .reverse()
      .slice(0, MAX_REVISIONS_PER_ARCHITECTURE);
  }

  async getRevision(
    actorInput: ArchitectureActorInput,
    architectureId: string,
    revisionId?: string,
  ): Promise<ArchitectureRevisionRecord | null> {
    const actor = await this.resolveActor(actorInput);
    const architecture = this.architectures.get(architectureId);
    if (!architecture) return null;
    const access = this.accessForArchitecture(actor, architecture);
    if (!access.canRead) return null;
    // Organization readers receive revision summaries through the API, but a
    // raw revision DTO could expose skill references outside that boundary.
    // Parent-owned preview code resolves an exact org-scoped release instead.
    if (access.reasons.includes("organization")) return null;
    const revision = revisionId
      ? architecture.revisions.find((candidate) => candidate.id === revisionId)
      : architecture.revisions.at(-1);
    return revision && revisionSpecReadableToActor(revision.spec, access)
      ? this.cloneRevision(revision, architecture, actor)
      : null;
  }

  async getRevisionForPreview(
    actorInput: ArchitectureActorInput,
    architectureId: string,
    revisionId?: string,
    organizationId?: string | null,
  ): Promise<ArchitectureRevisionRecord | null> {
    const actor = await this.resolveActor(actorInput);
    const architecture = this.architectures.get(architectureId);
    if (!architecture) return null;
    const access = this.accessForArchitecture(actor, architecture);
    if (!access.canPreview) return null;
    if (
      access.reasons.includes("organization")
      && (!organizationId || !access.allowedOrganizationIds.includes(organizationId))
    ) {
      return null;
    }
    const revision = revisionId
      ? architecture.revisions.find((candidate) => candidate.id === revisionId)
      : architecture.revisions.at(-1);
    return revision && revisionSpecReadableToActor(revision.spec, access)
      ? this.cloneRevision(revision, architecture, actor)
      : null;
  }

  async createArchitecture(input: CreateArchitectureInput): Promise<ArchitectureRecord>;
  async createArchitecture(actorInput: ArchitectureActorInput, input: CreateArchitectureInput, audit?: ArchitectureAuditInput): Promise<ArchitectureRecord>;
  async createArchitecture(
    first: CreateArchitectureInput | ArchitectureActorInput,
    second?: CreateArchitectureInput,
    audit?: ArchitectureAuditInput,
  ): Promise<ArchitectureRecord> {
    const input = second ?? first as CreateArchitectureInput;
    const owner = normalizeOwnerReference(input);
    if (!owner) {
      throw new AppError("Exactly one architecture owner is required.", "INVALID_ARCHITECTURE_OWNER", 400);
    }
    const actorInput = second ? first as ArchitectureActorInput : input.actor ?? owner.id;
    const actor = await this.resolveActor(actorInput);
    const decision = evaluateArchitectureAccess(actor, owner, "create");
    if (!decision.allowed) {
      throw new AppError(
        owner.type === "team" ? "Team owner access is required." : "Architecture owner access is required.",
        "ARCHITECTURE_OWNER_REQUIRED",
        403,
      );
    }
    const ownerCount = [...this.architectures.values()].filter((architecture) => sameOwner(architecture.owner, owner)).length;
    if (ownerCount >= MAX_ARCHITECTURES_PER_OWNER) {
      throw new AppError(
        `An owner may create at most ${MAX_ARCHITECTURES_PER_OWNER} architectures.`,
        "ARCHITECTURE_QUOTA_EXCEEDED",
        409,
      );
    }
    const now = new Date().toISOString();
    const architecture: MemoryArchitecture = {
      id: `architecture-${this.architectures.size + 1}-${randomUUID().slice(0, 8)}`,
      ownerUserId: owner.type === "user" ? owner.id : null,
      ownerTeamId: owner.type === "team" ? owner.id : null,
      owner,
      ownerType: owner.type,
      ownerId: owner.id,
      accessPolicyVersion: 1,
      access: emptyAccessMetadata(owner, 1),
      name: input.name,
      description: input.description,
      patternId: input.patternId,
      currentRevisionId: null,
      revisionCount: 0,
      createdAt: now,
      updatedAt: now,
      revisions: [],
    };
    architecture.access = this.accessForArchitecture(actor, architecture);
    const auditEvent = audit
      ? this.prepareArchitectureAudit(audit, actor.id, "architecture.create", architecture.id)
      : null;
    if (auditEvent && audit) await this.beforeCommit?.({ ...audit, resourceId: architecture.id });
    this.architectures.set(architecture.id, architecture);
    if (auditEvent) this.auditEvents.push(auditEvent);
    return this.stripRevisions(architecture, actor);
  }

  async createRevision(input: CreateArchitectureRevisionInput): Promise<ArchitectureRevisionRecord | null>;
  async createRevision(actorInput: ArchitectureActorInput, input: CreateArchitectureRevisionInput, audit?: ArchitectureAuditInput): Promise<ArchitectureRevisionRecord | null>;
  async createRevision(
    first: CreateArchitectureRevisionInput | ArchitectureActorInput,
    second?: CreateArchitectureRevisionInput,
    audit?: ArchitectureAuditInput,
  ): Promise<ArchitectureRevisionRecord | null> {
    const input = second ?? first as CreateArchitectureRevisionInput;
    const architecture = this.architectures.get(input.architectureId);
    if (!architecture) return null;
    const actorInput = second ? first as ArchitectureActorInput : input.actor ?? input.ownerUserId ?? "";
    const actor = await this.resolveActor(actorInput);
    if (!evaluateArchitectureAccess(actor, architecture.owner, "append-revision").allowed) return null;
    if (input.expectedCurrentRevisionId !== architecture.currentRevisionId) {
      throw new AppError(
        "The architecture changed after this draft was opened.",
        "ARCHITECTURE_REVISION_CONFLICT",
        409,
        { currentRevisionId: architecture.currentRevisionId },
      );
    }
    if (architecture.revisionCount >= MAX_REVISIONS_PER_ARCHITECTURE) {
      throw new AppError(
        `An architecture may contain at most ${MAX_REVISIONS_PER_ARCHITECTURE} revisions.`,
        "ARCHITECTURE_REVISION_QUOTA_EXCEEDED",
        409,
      );
    }
    const spec = validateArchitectureSpec(input.spec, architecture.patternId);
    assertArchitectureSpecSize(spec);
    const authorization = evaluateArchitectureRevisionAuthorizationIntent({
      actor,
      actorId: actor.id,
      architectureId: architecture.id,
      owner: architecture.owner,
      spec,
      authorizationSnapshot: input.authorizationSnapshot,
    });
    if (!authorization.allowed) {
      throw new AppError(
        "The exact architecture release authorization changed before this revision could be saved.",
        "ARCHITECTURE_REVISION_AUTHORIZATION_CONFLICT",
        409,
      );
    }
    const now = new Date().toISOString();
    const revision: ArchitectureRevisionRecord = {
      id: `revision-${architecture.revisionCount + 1}-${randomUUID().slice(0, 8)}`,
      architectureId: architecture.id,
      revisionNumber: architecture.revisionCount + 1,
      message: input.message,
      spec: structuredClone(spec),
      createdByUserId: actor.id,
      createdAt: now,
      access: this.accessForArchitecture(actor, architecture),
    };
    const auditEvent = audit
      ? this.prepareArchitectureAudit(audit, actor.id, "architecture.revision.create", architecture.id, revision.id, revision.revisionNumber)
      : null;
    if (auditEvent && audit) await this.beforeCommit?.({
      ...audit,
      resourceId: architecture.id,
      details: { ...(audit.details ?? {}), revisionId: revision.id, revisionNumber: revision.revisionNumber },
    });
    architecture.revisions.push(revision);
    architecture.revisionCount = revision.revisionNumber;
    architecture.currentRevisionId = revision.id;
    architecture.updatedAt = now;
    if (auditEvent) this.auditEvents.push(auditEvent);
    return this.cloneRevision(revision, architecture, actor);
  }

  async recordAuditEvent(input: ArchitectureAuditInput): Promise<void> {
    this.auditEvents.push(this.createAuditEvent(input));
  }

  async listAuditEvents(limit = 100): Promise<ArchitectureAuditEvent[]> {
    return this.auditEvents.slice(-Math.max(1, Math.min(limit, 500))).reverse().map((event) => ({
      ...event,
      details: structuredClone(event.details),
    }));
  }

  private prepareArchitectureAudit(
    input: ArchitectureAuditInput,
    actorUserId: string,
    action: "architecture.create" | "architecture.revision.create",
    resourceId: string,
    revisionId?: string,
    revisionNumber?: number,
  ): ArchitectureAuditEvent {
    if (
      input.action !== action
      || input.resourceType !== "skill_architecture"
      || input.actorUserId !== actorUserId
      || (input.resourceId !== undefined && input.resourceId !== null && input.resourceId !== resourceId)
    ) {
      throw new AppError("A valid architecture allow audit is required.", "INVALID_ARCHITECTURE_AUDIT", 400);
    }
    return this.createAuditEvent({
      ...input,
      resourceId,
      ...(revisionId === undefined || revisionNumber === undefined
        ? {}
        : { details: { ...(input.details ?? {}), revisionId, revisionNumber } }),
    });
  }

  private createAuditEvent(input: ArchitectureAuditInput): ArchitectureAuditEvent {
    return {
      id: `architecture-audit-${this.auditEvents.length + 1}`,
      actorUserId: input.actorUserId,
      action: input.action,
      decision: "allow",
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      details: sanitizeAuditDetails(input.details ?? {}),
      createdAt: new Date().toISOString(),
    };
  }

  private async resolveActor(actorInput: ArchitectureActorInput): Promise<ReturnType<typeof normalizeArchitectureActor>> {
    const actor = normalizeArchitectureActor(actorInput);
    const memberships = new Map<string, ArchitectureTeamMemberRole>();
    for (const membership of actor.teamMemberships ?? []) {
      memberships.set(membership.teamId, strongerRole(memberships.get(membership.teamId), membership.role));
    }
    for (const team of actor.teams ?? []) {
      memberships.set(team.id, strongerRole(memberships.get(team.id), team.role));
    }
    for (const teamId of actor.teamIds ?? []) {
      if (!memberships.has(teamId)) memberships.set(teamId, "member");
    }
    for (const [teamId, role] of this.memberships.get(actor.id) ?? []) {
      memberships.set(teamId, strongerRole(memberships.get(teamId), role));
    }
    if (this.teamStore?.listTeamsForUser) {
      const teams = await this.teamStore.listTeamsForUser(actor.id);
      for (const team of teams) {
        memberships.set(team.id, strongerRole(memberships.get(team.id), team.role));
      }
    }
    const organizationMemberships = new Map<string, ArchitectureOrganizationMembership["role"]>();
    for (const membership of actor.organizationMemberships ?? []) {
      organizationMemberships.set(
        membership.organizationId,
        strongerOrganizationRole(organizationMemberships.get(membership.organizationId), membership.role),
      );
    }
    for (const [organizationId, role] of this.organizationMemberships.get(actor.id) ?? []) {
      organizationMemberships.set(organizationId, strongerOrganizationRole(organizationMemberships.get(organizationId), role));
    }
    const currentOrganizationIds = new Set(organizationMemberships.keys());
    for (const [teamId] of memberships) {
      const organizationId = this.teamOrganizationIds.get(teamId);
      if (organizationId === undefined || organizationId === null) continue;
      const organization = this.organizations.get(organizationId);
      const currentPolicy = organization?.currentPolicyRevisionId
        ? this.organizationPolicies.get(organization.currentPolicyRevisionId)
        : undefined;
      if (
        organization?.status !== "active"
        || !currentOrganizationIds.has(organizationId)
        || !currentPolicy
        || currentPolicy.organizationId !== organizationId
      ) {
        memberships.delete(teamId);
      }
    }
    return {
      ...actor,
      teamMemberships: [...memberships.entries()].map(([teamId, role]) => ({ teamId, role })),
      organizationMemberships: [...organizationMemberships.entries()]
        .map(([organizationId, role]) => ({ organizationId, role })),
    };
  }

  private accessForArchitecture(
    actor: ReturnType<typeof normalizeArchitectureActor>,
    architecture: ArchitectureRecord,
  ): ArchitectureAccessMetadata {
    return architectureAccessForRecord(actor, architecture, {
      organizationVisibilityEnabled: this.organizationVisibilityEnabled,
      organizationGrantContexts: this.organizationGrantContexts(architecture.id),
    });
  }

  private organizationGrantContexts(architectureId: string): ArchitectureOrganizationGrantContext[] {
    const contexts: ArchitectureOrganizationGrantContext[] = [];
    const architecture = this.architectures.get(architectureId);
    const currentRevision = architecture?.currentRevisionId
      ? architecture.revisions.find((revision) => revision.id === architecture.currentRevisionId)
      : undefined;
    if (architecture?.currentRevisionId && (!currentRevision || !organizationRevisionSpecIsSafe(currentRevision.spec))) {
      return contexts;
    }
    for (const [organizationId, grant] of this.organizationGrants.get(architectureId) ?? []) {
      if (grant.accessLevel !== "read" || !grant.policyRevisionId) continue;
      const organization = this.organizations.get(organizationId);
      if (!organization || !organization.currentPolicyRevisionId) continue;
      const grantPolicy = this.organizationPolicies.get(grant.policyRevisionId);
      const currentPolicy = this.organizationPolicies.get(organization.currentPolicyRevisionId);
      if (!grantPolicy || !currentPolicy || grant.policyRevisionId !== organization.currentPolicyRevisionId) continue;
      let policy: OrganizationPolicyV1;
      try {
        policy = assertValidOrganizationPolicyV1(currentPolicy.policy);
      } catch {
        continue;
      }
      contexts.push({
        organizationId,
        accessLevel: "read",
        grantPolicyRevisionId: grant.policyRevisionId,
        grantPolicyOrganizationId: grantPolicy.organizationId,
        organizationStatus: organization.status,
        currentPolicyRevisionId: organization.currentPolicyRevisionId,
        currentPolicyOrganizationId: currentPolicy.organizationId,
        policy,
      });
    }
    return contexts.sort((left, right) => left.organizationId.localeCompare(right.organizationId));
  }

  private stripRevisions(
    architecture: MemoryArchitecture,
    actor: ReturnType<typeof normalizeArchitectureActor>,
  ): ArchitectureRecord {
    const { revisions: _revisions, ...record } = architecture;
    return {
      ...record,
      owner: { ...record.owner },
      access: this.accessForArchitecture(actor, architecture),
    };
  }

  private cloneRevision(
    revision: ArchitectureRevisionRecord,
    architecture: ArchitectureRecord,
    actor: ReturnType<typeof normalizeArchitectureActor>,
  ): ArchitectureRevisionRecord {
    return {
      ...revision,
      spec: structuredClone(revision.spec),
      ...(revision.access
        ? { access: this.accessForArchitecture(actor, architecture) }
        : {}),
    };
  }
}

function sameOwner(left: { type: string; id: string }, right: { type: string; id: string }): boolean {
  return left.type === right.type && left.id === right.id;
}

function strongerRole(current: ArchitectureTeamMemberRole | undefined, next: ArchitectureTeamMemberRole): ArchitectureTeamMemberRole {
  return current === "owner" || next === "owner" ? "owner" : "member";
}

function strongerOrganizationRole(
  current: ArchitectureOrganizationMembership["role"] | undefined,
  next: ArchitectureOrganizationMembership["role"],
): ArchitectureOrganizationMembership["role"] {
  if (current === "owner" || next === "owner") return "owner";
  if (current === "admin" || next === "admin") return "admin";
  return "member";
}

function organizationRevisionSpecIsSafe(spec: ArchitectureRevisionRecord["spec"]): boolean {
  return spec.skills.every((skill) => (
    skill.packageVisibility === "public"
    || skill.packageVisibility === "authenticated"
    || skill.packageVisibility === "organization"
  ));
}

function revisionSpecReadableToActor(
  spec: ArchitectureRevisionRecord["spec"],
  access: ArchitectureAccessMetadata,
): boolean {
  return !access.reasons.includes("organization") || organizationRevisionSpecIsSafe(spec);
}

function emptyAccessMetadata(owner: ArchitectureRecord["owner"], accessPolicyVersion: number): ArchitectureAccessMetadata {
  return {
    owner,
    ownerType: owner.type,
    ownerId: owner.id,
    policyVersion: accessPolicyVersion,
    accessPolicyVersion,
    role: "none",
    canList: false,
    canRead: false,
    canPreview: false,
    canCreate: false,
    canAppend: false,
    canManage: false,
    reasons: [],
    allowedOrganizationIds: [],
  };
}
