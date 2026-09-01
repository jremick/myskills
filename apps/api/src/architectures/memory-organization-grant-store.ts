import { AppError } from "@myskills-app/core";
import type {
  ArchitectureOrganizationGrant,
  ArchitectureOrganizationGrantStore,
  ReplaceArchitectureOrganizationGrantsStoreInput,
  ReplaceArchitectureOrganizationGrantsStoreResult,
} from "./organization-grant-service.js";
import {
  architectureOrganizationGrantPolicyFailureMessage,
  evaluateArchitectureOrganizationGrantPolicy,
  freezeArchitectureOrganizationGrantPolicySnapshot,
  type ArchitectureOrganizationGrantPolicySnapshot,
} from "./organization-grant-policy.js";

/**
 * Options for the deterministic grant repository used by unit and API
 * fixtures. The repository stores only grant metadata; release contents and
 * organization policy remain owned by their respective authorities.
 */
export interface MemoryArchitectureOrganizationGrantStoreOptions {
  now?: () => Date;
  grants?: readonly ArchitectureOrganizationGrant[];
  /** Builds the same frozen authorization shape used by PostgreSQL. */
  authorizationSnapshotProvider?: (
    input: ReplaceArchitectureOrganizationGrantsStoreInput,
  ) => ArchitectureOrganizationGrantPolicySnapshot | Promise<ArchitectureOrganizationGrantPolicySnapshot>;
}

/**
 * In-memory persistence for architecture-to-organization grants.
 *
 * `replaceArchitectureOrganizationGrants` stages and validates the complete
 * replacement before swapping the map entry. This gives callers the same
 * all-or-nothing behavior expected from the Postgres transaction boundary.
 */
export class MemoryArchitectureOrganizationGrantStore implements ArchitectureOrganizationGrantStore {
  readonly kind = "memory" as const;

  private readonly grantsByArchitecture = new Map<string, Map<string, ArchitectureOrganizationGrant>>();
  private readonly architectureMutationTails = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private readonly authorizationSnapshotProvider?: MemoryArchitectureOrganizationGrantStoreOptions["authorizationSnapshotProvider"];

  constructor(options: MemoryArchitectureOrganizationGrantStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.authorizationSnapshotProvider = options.authorizationSnapshotProvider;
    for (const grant of options.grants ?? []) this.seedGrant(grant);
  }

  async listArchitectureOrganizationGrants(architectureId: string): Promise<ArchitectureOrganizationGrant[]> {
    return [...(this.grantsByArchitecture.get(architectureId)?.values() ?? [])]
      .sort((left, right) => left.organizationId.localeCompare(right.organizationId))
      .map(cloneGrant);
  }

  /** Short alias for focused callers and fixtures. */
  async listGrants(architectureId: string): Promise<ArchitectureOrganizationGrant[]> {
    return this.listArchitectureOrganizationGrants(architectureId);
  }

  async countArchitectureOrganizationGrantsForOrganization(organizationId: string): Promise<number> {
    let count = 0;
    for (const grants of this.grantsByArchitecture.values()) {
      if ([...grants.values()].some((grant) => grant.organizationId === organizationId)) count += 1;
    }
    return count;
  }

  /** Short alias for authorities that use a compact count method name. */
  async countGrantsForOrganization(organizationId: string): Promise<number> {
    return this.countArchitectureOrganizationGrantsForOrganization(organizationId);
  }

  async replaceArchitectureOrganizationGrants(
    input: ReplaceArchitectureOrganizationGrantsStoreInput,
  ): Promise<ReplaceArchitectureOrganizationGrantsStoreResult> {
    return this.withArchitectureMutation(input.architectureId, async () => {
      // The service snapshot is only a preflight hint. If this fixture has an
      // authoritative provider, read it after entering the serialized
      // mutation so a concurrent current-revision change cannot be masked by
      // the caller's stale snapshot.
      const snapshot = this.authorizationSnapshotProvider
        ? await this.authorizationSnapshotProvider(input)
        : input.authorizationSnapshot;
      if (!snapshot) {
        throw new AppError(
          "Architecture organization grant authorization is unavailable.",
          "ARCHITECTURE_GRANT_MANAGE_REQUIRED",
          403,
        );
      }
      const decision = evaluateArchitectureOrganizationGrantPolicy(
        freezeArchitectureOrganizationGrantPolicySnapshot(snapshot),
        {
          architectureId: input.architectureId,
          actorUserId: input.actorUserId,
          expectedCurrentRevisionId: input.expectedCurrentRevisionId,
          grants: input.grants,
        },
      );
      if (!decision.allowed) {
        throw new AppError(
          architectureOrganizationGrantPolicyFailureMessage(decision.code),
          decision.code,
          decision.statusCode,
          decision.limit === undefined ? undefined : { limit: decision.limit },
        );
      }
      const staged = new Map<string, ArchitectureOrganizationGrant>();
      const seen = new Set<string>();
      for (const grant of input.grants) {
        validateGrant({
          ...grant,
          architectureId: input.architectureId,
          accessLevel: grant.accessLevel ?? "read",
        });
        if (seen.has(grant.organizationId)) {
          throw new AppError(
            "Architecture organization grants must contain one entry per organization.",
            "ARCHITECTURE_ORGANIZATION_GRANT_DUPLICATE",
            400,
          );
        }
        seen.add(grant.organizationId);
        staged.set(grant.organizationId, {
          architectureId: input.architectureId,
          organizationId: grant.organizationId,
          accessLevel: "read",
          createdByUserId: grant.createdByUserId ?? input.actorUserId,
          createdUnderPolicyRevisionId: grant.createdUnderPolicyRevisionId,
          createdAt: grant.createdAt ?? this.timestamp(),
        });
      }

      const existing = this.grantsByArchitecture.get(input.architectureId) ?? new Map<string, ArchitectureOrganizationGrant>();
      const changed = !sameGrantSet(existing, staged);
      const existingIds = new Set(existing.keys());
      const stagedIds = new Set(staged.keys());
      const addedOrganizationIds = [...stagedIds].filter((id) => !existingIds.has(id)).sort(compareStrings);
      const removedOrganizationIds = [...existingIds].filter((id) => !stagedIds.has(id)).sort(compareStrings);
      const grants = [...(changed ? staged : existing).values()]
        .sort((left, right) => left.organizationId.localeCompare(right.organizationId))
        .map(cloneGrant);
      // The memory adapter stages the complete replacement and records the
      // allow audit before swapping the map entry. A failing audit therefore
      // leaves the prior grant set untouched, matching PostgreSQL's single
      // transaction boundary. Direct store callers may omit the hook.
      await input.recordAllowAuditEvent?.({
        actorUserId: input.actorUserId,
        action: "architecture.organization-grants.replace",
        resourceType: "architecture",
        resourceId: input.architectureId,
        details: {
          currentRevisionId: input.expectedCurrentRevisionId,
          organizationIds: [...stagedIds].sort(compareStrings),
          organizationGrantCount: staged.size,
          addedCount: addedOrganizationIds.length,
          removedCount: removedOrganizationIds.length,
          changed,
        },
      });
      if (changed) this.grantsByArchitecture.set(input.architectureId, staged);

      return {
        grants,
        changed,
        addedOrganizationIds,
        removedOrganizationIds,
      };
    });
  }

  /** Short alias for focused callers and fixtures. */
  async replaceGrants(
    input: ReplaceArchitectureOrganizationGrantsStoreInput,
  ): Promise<ReplaceArchitectureOrganizationGrantsStoreResult> {
    return this.replaceArchitectureOrganizationGrants(input);
  }

  /** Seed or replace one row in a fixture without bypassing row validation. */
  seedGrant(grant: ArchitectureOrganizationGrant): void {
    validateGrant(grant);
    const byOrganization = this.grantsByArchitecture.get(grant.architectureId) ?? new Map<string, ArchitectureOrganizationGrant>();
    byOrganization.set(grant.organizationId, {
      architectureId: grant.architectureId,
      organizationId: grant.organizationId,
      accessLevel: "read",
      createdByUserId: grant.createdByUserId ?? null,
      createdUnderPolicyRevisionId: grant.createdUnderPolicyRevisionId,
      createdAt: grant.createdAt ?? this.timestamp(),
    });
    this.grantsByArchitecture.set(grant.architectureId, byOrganization);
  }

  /** Alias retained for readable test fixtures. */
  addGrant(grant: ArchitectureOrganizationGrant): void {
    this.seedGrant(grant);
  }

  removeGrant(architectureId: string, organizationId: string): void {
    const grants = this.grantsByArchitecture.get(architectureId);
    grants?.delete(organizationId);
    if (grants && grants.size === 0) this.grantsByArchitecture.delete(architectureId);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  /** Mirror the PostgreSQL architecture lock for concurrent replacements. */
  private async withArchitectureMutation<T>(architectureId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.architectureMutationTails.get(architectureId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.architectureMutationTails.set(architectureId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.architectureMutationTails.get(architectureId) === current) {
        this.architectureMutationTails.delete(architectureId);
      }
    }
  }
}

function validateGrant(grant: Pick<ArchitectureOrganizationGrant, "architectureId" | "organizationId" | "accessLevel" | "createdUnderPolicyRevisionId">): void {
  if (!isIdentifier(grant.architectureId) || !isIdentifier(grant.organizationId) || !isIdentifier(grant.createdUnderPolicyRevisionId)) {
    throw new AppError("Architecture organization grant identifiers are invalid.", "INVALID_ARCHITECTURE_ORGANIZATION_GRANT", 400);
  }
  if (grant.accessLevel !== "read") {
    throw new AppError("Architecture organization grants are read-only.", "ARCHITECTURE_ORGANIZATION_GRANT_ACCESS_INVALID", 400);
  }
}

function sameGrantSet(
  left: Map<string, ArchitectureOrganizationGrant>,
  right: Map<string, ArchitectureOrganizationGrant>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [organizationId, candidate] of right) {
    const existing = left.get(organizationId);
    if (!existing
      || existing.accessLevel !== candidate.accessLevel
      || existing.createdUnderPolicyRevisionId !== candidate.createdUnderPolicyRevisionId) return false;
  }
  return true;
}

function cloneGrant(grant: ArchitectureOrganizationGrant): ArchitectureOrganizationGrant {
  return { ...grant };
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
