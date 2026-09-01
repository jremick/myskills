import { randomUUID } from "node:crypto";
import {
  AppError,
  architectureDigest,
  architecturePatternIds,
  architecturePatternMigrationDigest,
  assertValidArchitectureSpec,
  canonicalizeJson,
  deriveArchitecturePatternMigration,
  sha256Hex,
  type ArchitecturePatternId,
  type ArchitecturePatternMigrationDiff,
  type ArchitecturePatternMigrationInput,
  type ArchitecturePatternMigrationIssue,
  type ArchitecturePatternMigrationMapping,
  type ArchitecturePatternMigrationResult,
} from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import {
  type ArchitectureActorInput,
  type ArchitectureOwnerReference,
  type ArchitectureRecord,
  type ArchitectureRevisionRecord,
  type ArchitectureStore,
} from "./types.js";

/** Inputs shared by the read-only preview and persisted create operations. */
export interface ArchitecturePatternMigrationPreviewInput {
  actor: ArchitectureActorInput;
  architectureId: string;
  /** The source must still point at this revision when the request is handled. */
  expectedCurrentRevisionId: string;
  targetPatternId: ArchitecturePatternId;
  mapping?: ArchitecturePatternMigrationMapping;
}

export interface ArchitecturePatternMigrationCreateInput extends ArchitecturePatternMigrationPreviewInput {
  idempotencyKey: string;
  name: string;
  description?: string;
  message?: string;
}

/** A bounded preview wrapper. It contains no generated shell, revision, or lineage IDs. */
export interface ArchitecturePatternMigrationPreviewResult {
  sourceArchitectureId: string;
  sourceRevisionId: string;
  expectedCurrentRevisionId: string;
  migration: ArchitecturePatternMigrationResult;
}

export interface ArchitecturePatternMigrationLineage {
  id: string;
  schemaVersion: 1;
  mode: "derive-shell";
  sourceArchitectureId: string;
  sourceRevisionId: string;
  sourcePatternId: ArchitecturePatternId;
  sourceRevisionDigest: string;
  targetArchitectureId: string;
  targetRevisionId: string;
  targetPatternId: ArchitecturePatternId;
  targetRevisionDigest: string;
  mappingStatus: Exclude<ArchitecturePatternMigrationResult["mappingStatus"], "blocked">;
  mapping: ArchitecturePatternMigrationMapping;
  diff: ArchitecturePatternMigrationDiff;
  migrationDigest: string;
  diffDigest: string;
  actorUserId: string;
  idempotencyKey: string;
  createdAt: string;
}

/** The only persistence operation used by create: shell, first revision, and lineage commit together. */
export interface ArchitecturePatternMigrationPersistedRecord {
  targetArchitecture: ArchitectureRecord;
  targetRevision: ArchitectureRevisionRecord;
  lineage: ArchitecturePatternMigrationLineage;
}

export interface ArchitecturePatternMigrationCreateStoreInput {
  actorId: string;
  expectedCurrentRevisionId: string;
  /** Source snapshots are read-only and are used for the repository's concurrency guard. */
  sourceArchitecture: ArchitectureRecord;
  sourceRevision: ArchitectureRevisionRecord;
  targetArchitecture: ArchitectureRecord;
  targetRevision: ArchitectureRevisionRecord;
  lineage: ArchitecturePatternMigrationLineage;
  /** Required allow decision committed with the derived shell. */
  audit: ArchitecturePatternMigrationAuditInput;
  /** Stable request intent; generated IDs and timestamps must not affect replay. */
  intentDigest: string;
}

export interface ArchitecturePatternMigrationCreateStoreResult {
  record: ArchitecturePatternMigrationPersistedRecord;
  replayed: boolean;
}

export interface ArchitecturePatternMigrationStore {
  readonly kind: "memory" | "postgres";
  /** Bind the canonical source store used for memory commit-time revalidation. */
  bindSourceStore?(sourceStore: ArchitectureStore): void;
  /** Return an existing actor-scoped idempotent result without exposing private request state. */
  getByIdempotencyKey(actorId: string, idempotencyKey: string): Promise<ArchitecturePatternMigrationPersistedRecord | null>;
  /** Atomically create the target shell, first revision, and immutable lineage. */
  createDerivedShell(input: ArchitecturePatternMigrationCreateStoreInput): Promise<ArchitecturePatternMigrationCreateStoreResult>;
  recordAuditEvent(input: ArchitecturePatternMigrationAuditInput): Promise<void>;
  listAuditEvents(limit?: number): Promise<ArchitecturePatternMigrationAuditEvent[]>;
}

/**
 * Canonical read boundary for deployments that use a separate migration
 * journal. An implementation must expose committed target shells and their
 * revisions through the same ArchitectureStore contract used by list/get
 * callers. The memory adapter is provided by MemoryPatternMigrationStore's
 * `asArchitectureStore` method; the Postgres implementation should provide
 * the equivalent transaction-backed aggregate.
 */
export interface ArchitecturePatternMigrationArchitectureAggregate extends ArchitectureStore {
  readonly patternMigrationStore: ArchitecturePatternMigrationStore;
}

export interface ArchitecturePatternMigrationReleaseAuthorizationInput {
  actorId: string;
  owner: ArchitectureOwnerReference;
  sourceArchitectureId: string;
  sourceRevisionId: string;
  sourcePatternId: ArchitecturePatternId;
  sourceRevisionDigest: string;
  targetPatternId: ArchitecturePatternId;
  /** Server-derived target candidate. Clients cannot supply this spec. */
  targetSpec: ArchitecturePatternMigrationInput["source"];
  /** Exact current organization contexts resolved on the source access record. */
  organizationIds: readonly string[];
}

export interface ArchitecturePatternMigrationReleaseAuthorization {
  allowed: boolean;
  /** Bounded machine code. Arbitrary provider or registry messages are not returned. */
  code?: string;
}

/**
 * Authorizes every exact slug/version/digest reference in the derived source
 * candidate. The service never chooses a latest release or accepts a client
 * supplied full specification.
 */
export interface ArchitecturePatternMigrationReleaseAuthorizationPort {
  authorize(input: ArchitecturePatternMigrationReleaseAuthorizationInput): Promise<ArchitecturePatternMigrationReleaseAuthorization | boolean>;
}

export interface ArchitecturePatternMigrationServiceOptions {
  now?: () => Date;
  idFactory?: () => string;
  releaseAuthorizer?: ArchitecturePatternMigrationReleaseAuthorizationPort;
  /** Optional bound for the serialized preview/create result. */
  maxResultBytes?: number;
}

export interface ArchitecturePatternMigrationCreateResult {
  sourceArchitectureId: string;
  sourceRevisionId: string;
  expectedCurrentRevisionId: string;
  migration: ArchitecturePatternMigrationResult;
  created: boolean;
  replayed: boolean;
  persisted?: ArchitecturePatternMigrationPersistedRecord;
}

export interface ArchitecturePatternMigrationAuditInput {
  actorUserId: string;
  action: string;
  decision: "allow" | "deny";
  resourceId?: string | null;
  details?: Record<string, unknown>;
}

export interface ArchitecturePatternMigrationAuditEvent extends ArchitecturePatternMigrationAuditInput {
  id: string;
  resourceId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_MESSAGE_LENGTH = 500;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;

type NormalizedPreviewInput = Omit<ArchitecturePatternMigrationPreviewInput, "actor" | "mapping"> & {
  actor: ArchitectureActorInput;
  actorId: string;
  mapping?: ArchitecturePatternMigrationMapping;
};

type NormalizedCreateInput = NormalizedPreviewInput & {
  idempotencyKey: string;
  name: string;
  description: string;
  message: string;
};

interface SourceContext {
  actorId: string;
  architecture: ArchitectureRecord;
  revision: ArchitectureRevisionRecord;
  sourceDigest: string;
}

/**
 * Application orchestration for the derive-shell pattern migration.
 *
 * This service owns request sequencing and identity injection. It does not
 * query a registry, inspect package bodies, rebind targets, or copy grants.
 */
export class ArchitecturePatternMigrationService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly releaseAuthorizer?: ArchitecturePatternMigrationReleaseAuthorizationPort;
  private readonly maxResultBytes: number;

  constructor(
    private readonly architectureStore: ArchitectureStore,
    private readonly migrationStore: ArchitecturePatternMigrationStore,
    options: ArchitecturePatternMigrationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.releaseAuthorizer = options.releaseAuthorizer;
    this.maxResultBytes = boundedResultBytes(options.maxResultBytes);
    this.migrationStore.bindSourceStore?.(architectureStore);
  }

  /** Build a bounded candidate without persistence, identity allocation, or release authorization. */
  async preview(input: ArchitecturePatternMigrationPreviewInput): Promise<ArchitecturePatternMigrationPreviewResult> {
    const normalized = normalizePreviewInput(input);
    let source: SourceContext | undefined;
    try {
      source = await this.loadSource(normalized);
      const migration = this.derive(source, normalized.targetPatternId, normalized.mapping);
      this.assertBoundedResult(migration);
      await this.recordAuditSafe({
        actorUserId: source.actorId,
        action: "architecture.pattern-migration.preview",
        decision: migration.mappingStatus === "blocked" ? "deny" : "allow",
        resourceId: source.architecture.id,
        details: migrationAuditDetails({
          sourceArchitectureId: source.architecture.id,
          sourceRevisionId: source.revision.id,
          sourcePatternId: source.revision.spec.pattern.id,
          targetPatternId: normalized.targetPatternId,
          sourceRevisionDigest: source.sourceDigest,
          code: migration.mappingStatus === "blocked" ? issueCode(migration.issues) : "preview.ready",
          diff: migration.diff,
          targetRevisionDigest: migration.target?.revisionDigest,
          migrationDigest: migration.migrationDigest,
          diffDigest: migration.diffDigest,
        }),
      });
      return {
        sourceArchitectureId: source.architecture.id,
        sourceRevisionId: source.revision.id,
        expectedCurrentRevisionId: normalized.expectedCurrentRevisionId,
        migration,
      };
    } catch (error) {
      const actorId = source?.actorId ?? normalized.actorId;
      await this.recordAuditSafe({
        actorUserId: actorId,
        action: "architecture.pattern-migration.preview",
        decision: "deny",
        resourceId: normalized.architectureId,
        details: { code: errorCode(error, "ARCHITECTURE_PATTERN_MIGRATION_PREVIEW_FAILED") },
      });
      throw error;
    }
  }

  /** Alias used by non-HTTP callers that name the operation explicitly. */
  async previewMigration(input: ArchitecturePatternMigrationPreviewInput): Promise<ArchitecturePatternMigrationPreviewResult> {
    return this.preview(input);
  }

  /** Route-oriented alias for `/pattern-migrations/preview`. */
  async previewPatternMigration(input: ArchitecturePatternMigrationPreviewInput): Promise<ArchitecturePatternMigrationPreviewResult> {
    return this.preview(input);
  }

  /**
   * Derive and atomically persist a new shell. A blocked core result is
   * returned as a non-created result; authorization and repository failures
   * throw bounded AppErrors.
   */
  async create(input: ArchitecturePatternMigrationCreateInput): Promise<ArchitecturePatternMigrationCreateResult> {
    const normalized = normalizeCreateInput(input);
    let source: SourceContext | undefined;
    try {
      // Idempotent replay is resolved before the current-pointer gate. A
      // source may have advanced after the original commit; replay still
      // returns the immutable derived shell, subject to a fresh access check.
      const existing = await this.migrationStore.getByIdempotencyKey(normalized.actorId, normalized.idempotencyKey);
      if (existing) {
        if (
          existing.lineage.sourceArchitectureId !== normalized.architectureId
          || existing.lineage.sourceRevisionId !== normalized.expectedCurrentRevisionId
        ) {
          throw new AppError(
            "This idempotency key was already used for a different pattern migration.",
            "ARCHITECTURE_PATTERN_MIGRATION_IDEMPOTENCY_CONFLICT",
            409,
          );
        }
        await this.loadReplayArchitecture(normalized, existing);
        const intentDigest = migrationIntentDigest({
          actorId: normalized.actorId,
          sourceArchitectureId: normalized.architectureId,
          sourceRevisionId: normalized.expectedCurrentRevisionId,
          expectedCurrentRevisionId: normalized.expectedCurrentRevisionId,
          owner: existing.targetArchitecture.owner,
          sourceRevisionDigest: existing.lineage.sourceRevisionDigest,
          targetPatternId: normalized.targetPatternId,
          mapping: normalized.mapping,
          name: normalized.name,
          description: normalized.description,
          message: normalized.message,
        });
        if (migrationIntentDigestFromRecord(existing) !== intentDigest) {
          throw new AppError(
            "This idempotency key was already used for a different pattern migration.",
            "ARCHITECTURE_PATTERN_MIGRATION_IDEMPOTENCY_CONFLICT",
            409,
          );
        }
        const replayMigration = this.migrationFromPersisted(existing);
        this.assertBoundedResult(replayMigration);
        await this.recordAuditSafe({
          actorUserId: normalized.actorId,
          action: "architecture.pattern-migration.create",
          decision: "allow",
          resourceId: existing.targetArchitecture.id,
          details: migrationAuditDetails({
            sourceArchitectureId: existing.lineage.sourceArchitectureId,
            sourceRevisionId: existing.lineage.sourceRevisionId,
            sourcePatternId: existing.lineage.sourcePatternId,
            targetPatternId: existing.targetArchitecture.patternId,
            targetArchitectureId: existing.targetArchitecture.id,
            targetRevisionId: existing.targetRevision.id,
            sourceRevisionDigest: existing.lineage.sourceRevisionDigest,
            targetRevisionDigest: existing.lineage.targetRevisionDigest,
            migrationDigest: existing.lineage.migrationDigest,
            diffDigest: existing.lineage.diffDigest,
            code: "create.replayed",
            diff: existing.lineage.diff,
          }),
        });
        return {
          sourceArchitectureId: existing.lineage.sourceArchitectureId,
          sourceRevisionId: existing.lineage.sourceRevisionId,
          expectedCurrentRevisionId: normalized.expectedCurrentRevisionId,
          migration: this.migrationFromPersisted(existing),
          created: false,
          replayed: true,
          persisted: existing,
        };
      }

      source = await this.loadSource(normalized);
      const migration = this.derive(source, normalized.targetPatternId, normalized.mapping);
      this.assertBoundedResult(migration);
      if (migration.mappingStatus === "blocked") {
        await this.recordAuditSafe({
          actorUserId: source.actorId,
          action: "architecture.pattern-migration.create",
          decision: "deny",
          resourceId: source.architecture.id,
          details: migrationAuditDetails({
            sourceArchitectureId: source.architecture.id,
            sourceRevisionId: source.revision.id,
            sourcePatternId: source.revision.spec.pattern.id,
            targetPatternId: normalized.targetPatternId,
            sourceRevisionDigest: source.sourceDigest,
            code: issueCode(migration.issues),
            diff: migration.diff,
            migrationDigest: migration.migrationDigest,
            diffDigest: migration.diffDigest,
          }),
        });
        return {
          sourceArchitectureId: source.architecture.id,
          sourceRevisionId: source.revision.id,
          expectedCurrentRevisionId: normalized.expectedCurrentRevisionId,
          migration,
          created: false,
          replayed: false,
        };
      }

      const intentDigest = migrationIntentDigest({
        actorId: source.actorId,
        sourceArchitectureId: source.architecture.id,
        sourceRevisionId: source.revision.id,
        expectedCurrentRevisionId: normalized.expectedCurrentRevisionId,
        owner: source.architecture.owner,
        sourceRevisionDigest: source.sourceDigest,
        targetPatternId: normalized.targetPatternId,
        mapping: normalized.mapping,
        name: normalized.name,
        description: normalized.description,
        message: normalized.message,
      });

      const persistedCandidate = this.buildPersistedCandidate({ source, normalized, migration });
      const candidateMigration = migrationFromCandidate(persistedCandidate, migration);
      // Bound the final server-derived result, including caller-controlled
      // shell metadata, before the persistence transaction starts.
      this.assertBoundedResult(candidateMigration);
      // Authorize the exact server-derived candidate, including its
      // authoritative shell metadata. The client never supplies a full spec.
      await this.authorizeExactReleases(source, persistedCandidate.targetRevision.spec, normalized.targetPatternId);
      const allowAudit: ArchitecturePatternMigrationAuditInput = {
        actorUserId: source.actorId,
        action: "architecture.pattern-migration.create",
        decision: "allow",
        resourceId: persistedCandidate.targetArchitecture.id,
        details: migrationAuditDetails({
          sourceArchitectureId: source.architecture.id,
          sourceRevisionId: source.revision.id,
          sourcePatternId: source.revision.spec.pattern.id,
          targetPatternId: persistedCandidate.targetArchitecture.patternId,
          targetArchitectureId: persistedCandidate.targetArchitecture.id,
          targetRevisionId: persistedCandidate.targetRevision.id,
          sourceRevisionDigest: source.sourceDigest,
          targetRevisionDigest: persistedCandidate.lineage.targetRevisionDigest,
          migrationDigest: persistedCandidate.lineage.migrationDigest,
          diffDigest: persistedCandidate.lineage.diffDigest,
          code: "create.committed",
          diff: persistedCandidate.lineage.diff,
        }),
      };
      const saved = await this.migrationStore.createDerivedShell({
        actorId: source.actorId,
        expectedCurrentRevisionId: normalized.expectedCurrentRevisionId,
        sourceArchitecture: source.architecture,
        sourceRevision: source.revision,
        ...persistedCandidate,
        audit: allowAudit,
        intentDigest,
      });
      const savedMigration = saved.replayed ? this.migrationFromPersisted(saved.record) : candidateMigration;
      if (saved.replayed) {
        await this.recordAuditSafe({
          actorUserId: source.actorId,
          action: "architecture.pattern-migration.create",
          decision: "allow",
          resourceId: saved.record.targetArchitecture.id,
          details: migrationAuditDetails({
            sourceArchitectureId: source.architecture.id,
            sourceRevisionId: source.revision.id,
            sourcePatternId: source.revision.spec.pattern.id,
            targetPatternId: saved.record.targetArchitecture.patternId,
            targetArchitectureId: saved.record.targetArchitecture.id,
            targetRevisionId: saved.record.targetRevision.id,
            sourceRevisionDigest: source.sourceDigest,
            targetRevisionDigest: saved.record.lineage.targetRevisionDigest,
            migrationDigest: saved.record.lineage.migrationDigest,
            diffDigest: saved.record.lineage.diffDigest,
            code: "create.replayed",
            diff: saved.record.lineage.diff,
          }),
        });
      }
      return {
        sourceArchitectureId: source.architecture.id,
        sourceRevisionId: source.revision.id,
        expectedCurrentRevisionId: normalized.expectedCurrentRevisionId,
        migration: savedMigration,
        created: !saved.replayed,
        replayed: saved.replayed,
        persisted: saved.record,
      };
    } catch (error) {
      const actorId = source?.actorId ?? normalized.actorId;
      await this.recordAuditSafe({
        actorUserId: actorId,
        action: "architecture.pattern-migration.create",
        decision: "deny",
        resourceId: source?.architecture.id ?? normalized.architectureId,
        details: { code: errorCode(error, "ARCHITECTURE_PATTERN_MIGRATION_CREATE_FAILED") },
      });
      throw error;
    }
  }

  /** Alias used by future route composition. */
  async createMigration(input: ArchitecturePatternMigrationCreateInput): Promise<ArchitecturePatternMigrationCreateResult> {
    return this.create(input);
  }

  /** Route-oriented alias for `/pattern-migrations`. */
  async createPatternMigration(input: ArchitecturePatternMigrationCreateInput): Promise<ArchitecturePatternMigrationCreateResult> {
    return this.create(input);
  }

  private async loadSource(input: NormalizedPreviewInput): Promise<SourceContext> {
    const architecture = await this.architectureStore.getArchitecture(input.actor, input.architectureId);
    if (!architecture) {
      throw new AppError("Architecture not found.", "ARCHITECTURE_NOT_FOUND", 404);
    }
    // The store's access metadata is the authority after it resolves current
    // membership. A team member can read but cannot initiate a migration.
    if (!architecture.access.canAppend || !architecture.access.canManage || !architecture.access.canCreate) {
      throw new AppError(
        architecture.owner.type === "team" ? "Team owner access is required." : "Architecture owner access is required.",
        "ARCHITECTURE_PATTERN_MIGRATION_FORBIDDEN",
        403,
      );
    }
    if (architecture.currentRevisionId !== input.expectedCurrentRevisionId) {
      throw new AppError(
        "The architecture changed after this migration was opened.",
        "ARCHITECTURE_PATTERN_MIGRATION_REVISION_CONFLICT",
        409,
        { currentRevisionId: architecture.currentRevisionId },
      );
    }
    const revision = await this.architectureStore.getRevision(
      input.actor,
      architecture.id,
      input.expectedCurrentRevisionId,
    );
    if (!revision || revision.id !== input.expectedCurrentRevisionId || revision.architectureId !== architecture.id) {
      throw new AppError("Architecture revision not found.", "ARCHITECTURE_PATTERN_MIGRATION_SOURCE_REVISION_NOT_FOUND", 404);
    }
    if (revision.spec.id !== architecture.id || revision.spec.pattern.id !== architecture.patternId) {
      throw new AppError(
        "The source architecture and current revision do not share an immutable pattern identity.",
        "ARCHITECTURE_PATTERN_MIGRATION_SOURCE_INVALID",
        409,
      );
    }
    return {
      actorId: input.actorId,
      architecture,
      revision,
      sourceDigest: architectureDigest(revision.spec),
    };
  }

  private async loadReplayArchitecture(
    input: NormalizedCreateInput,
    existing: ArchitecturePatternMigrationPersistedRecord,
  ): Promise<ArchitectureRecord> {
    const architecture = await this.architectureStore.getArchitecture(input.actor, input.architectureId);
    if (!architecture) {
      throw new AppError("Architecture not found.", "ARCHITECTURE_NOT_FOUND", 404);
    }
    if (!architecture.access.canAppend || !architecture.access.canManage || !architecture.access.canCreate) {
      throw new AppError(
        architecture.owner.type === "team" ? "Team owner access is required." : "Architecture owner access is required.",
        "ARCHITECTURE_PATTERN_MIGRATION_FORBIDDEN",
        403,
      );
    }
    if (
      architecture.id !== existing.lineage.sourceArchitectureId
      || architecture.patternId !== existing.lineage.sourcePatternId
      || !sameOwner(architecture.owner, existing.targetArchitecture.owner)
    ) {
      throw new AppError(
        "This idempotency key was already used for a different pattern migration.",
        "ARCHITECTURE_PATTERN_MIGRATION_IDEMPOTENCY_CONFLICT",
        409,
      );
    }
    return architecture;
  }

  private derive(
    source: SourceContext,
    targetPatternId: ArchitecturePatternId,
    mapping: ArchitecturePatternMigrationMapping | undefined,
  ): ArchitecturePatternMigrationResult {
    return deriveArchitecturePatternMigration({
      source: structuredClone(source.revision.spec),
      targetPatternId,
      ...(mapping === undefined ? {} : { mapping: structuredClone(mapping) }),
    });
  }

  private async authorizeExactReleases(
    source: SourceContext,
    targetSpec: ArchitecturePatternMigrationInput["source"],
    targetPatternId: ArchitecturePatternId,
  ): Promise<void> {
    if (!this.releaseAuthorizer) {
      throw new AppError(
        "Exact release authorization is required before a pattern migration can be created.",
        "ARCHITECTURE_PATTERN_MIGRATION_RELEASE_AUTHORIZATION_REQUIRED",
        503,
      );
    }
    let decision: ArchitecturePatternMigrationReleaseAuthorization | boolean;
    try {
      decision = await this.releaseAuthorizer.authorize({
        actorId: source.actorId,
        owner: { ...source.architecture.owner },
        sourceArchitectureId: source.architecture.id,
        sourceRevisionId: source.revision.id,
        sourcePatternId: source.revision.spec.pattern.id,
        sourceRevisionDigest: source.sourceDigest,
        targetPatternId,
        targetSpec: structuredClone(targetSpec),
        organizationIds: [...(source.architecture.access.allowedOrganizationIds ?? [])].sort(),
      });
    } catch {
      throw new AppError(
        "Exact release authorization could not be completed.",
        "ARCHITECTURE_PATTERN_MIGRATION_RELEASE_AUTHORIZATION_FAILED",
        503,
      );
    }
    const allowed = typeof decision === "boolean" ? decision : decision.allowed;
    if (!allowed) {
      const code = typeof decision === "boolean" ? undefined : safeCode(decision.code);
      throw new AppError(
        "One or more exact architecture releases are not authorized for this actor and source context.",
        "ARCHITECTURE_PATTERN_MIGRATION_RELEASE_DENIED",
        403,
        code ? { code } : undefined,
      );
    }
  }

  private buildPersistedCandidate(input: {
    source: SourceContext;
    normalized: NormalizedCreateInput;
    migration: Extract<ArchitecturePatternMigrationResult, { target: { patternId: ArchitecturePatternId } }>;
  }): Omit<ArchitecturePatternMigrationCreateStoreInput, "actorId" | "expectedCurrentRevisionId" | "sourceArchitecture" | "sourceRevision" | "audit" | "intentDigest"> {
    const targetArchitectureId = this.newId();
    const targetRevisionId = this.newId();
    const lineageId = this.newId();
    const description = input.normalized.description || undefined;
    const targetSpec = assertValidArchitectureSpec({
      ...structuredClone(input.migration.target.spec),
      id: targetArchitectureId,
      name: input.normalized.name,
      ...(description === undefined ? { description: undefined } : { description }),
      pattern: { id: input.normalized.targetPatternId, version: 1 },
    });
    const targetRevisionDigest = architectureDigest(targetSpec);
    const migration: ArchitecturePatternMigrationResult = {
      ...structuredClone(input.migration),
      target: {
        patternId: input.normalized.targetPatternId,
        spec: targetSpec,
        revisionDigest: targetRevisionDigest,
      },
    };
    migration.migrationDigest = architecturePatternMigrationDigest(migration);
    const createdAt = this.timestamp();
    const owner = { ...input.source.architecture.owner };
    const targetArchitecture: ArchitectureRecord = {
      id: targetArchitectureId,
      ownerUserId: owner.type === "user" ? owner.id : null,
      ownerTeamId: owner.type === "team" ? owner.id : null,
      owner,
      ownerType: owner.type,
      ownerId: owner.id,
      accessPolicyVersion: input.source.architecture.accessPolicyVersion,
      access: cloneAccess(input.source.architecture.access),
      name: input.normalized.name,
      description: input.normalized.description,
      patternId: input.normalized.targetPatternId,
      currentRevisionId: targetRevisionId,
      revisionCount: 1,
      createdAt,
      updatedAt: createdAt,
    };
    // A derived shell starts with owner-only access. The source's effective
    // organization grant projection is deliberately not copied or rebound;
    // any future sharing decision must create a new, policy-bound grant.
    targetArchitecture.access = ownerAccessMetadata(owner, targetArchitecture.accessPolicyVersion);
    const targetRevision: ArchitectureRevisionRecord = {
      id: targetRevisionId,
      architectureId: targetArchitectureId,
      revisionNumber: 1,
      message: input.normalized.message,
      spec: structuredClone(targetSpec),
      createdByUserId: input.source.actorId,
      createdAt,
      access: cloneAccess(targetArchitecture.access),
    };
    const normalizedMapping = input.normalized.mapping === undefined
      ? {}
      : structuredClone(input.normalized.mapping);
    const lineage: ArchitecturePatternMigrationLineage = {
      id: lineageId,
      schemaVersion: 1,
      mode: "derive-shell",
      sourceArchitectureId: input.source.architecture.id,
      sourceRevisionId: input.source.revision.id,
      sourcePatternId: input.source.revision.spec.pattern.id,
      sourceRevisionDigest: input.source.sourceDigest,
      targetArchitectureId,
      targetRevisionId,
      targetPatternId: input.normalized.targetPatternId,
      targetRevisionDigest,
      mappingStatus: migration.mappingStatus,
      mapping: normalizedMapping,
      diff: structuredClone(migration.diff),
      migrationDigest: migration.migrationDigest,
      diffDigest: migration.diffDigest,
      actorUserId: input.source.actorId,
      idempotencyKey: input.normalized.idempotencyKey,
      createdAt,
    };
    return { targetArchitecture, targetRevision, lineage };
  }

  private migrationFromPersisted(record: ArchitecturePatternMigrationPersistedRecord): ArchitecturePatternMigrationResult {
    const lineage = record.lineage;
    const result: ArchitecturePatternMigrationResult = {
      schemaVersion: 1,
      mode: "derive-shell",
      source: {
        architectureId: lineage.sourceArchitectureId,
        patternId: lineage.sourcePatternId,
        revisionDigest: lineage.sourceRevisionDigest,
      },
      target: {
        patternId: lineage.targetPatternId,
        spec: structuredClone(record.targetRevision.spec),
        revisionDigest: lineage.targetRevisionDigest,
      },
      mappingStatus: lineage.mappingStatus,
      diff: structuredClone(lineage.diff),
      issues: [],
      migrationDigest: lineage.migrationDigest,
      diffDigest: lineage.diffDigest,
    };
    return result;
  }

  private newId(): string {
    const value = this.idFactory();
    if (!IDENTIFIER_PATTERN.test(value)) {
      throw new AppError("Generated architecture migration identity is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_ID_INVALID", 500);
    }
    return value;
  }

  private assertBoundedResult(result: ArchitecturePatternMigrationResult): void {
    let serialized: string;
    try {
      serialized = canonicalizeJson(result);
    } catch {
      throw new AppError("Pattern migration result is not serializable.", "ARCHITECTURE_PATTERN_MIGRATION_RESULT_INVALID", 500);
    }
    if (Buffer.byteLength(serialized, "utf8") > this.maxResultBytes) {
      throw new AppError("Pattern migration result is too large.", "ARCHITECTURE_PATTERN_MIGRATION_RESULT_TOO_LARGE", 413);
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async recordAuditSafe(input: ArchitecturePatternMigrationAuditInput): Promise<void> {
    try {
      await this.migrationStore.recordAuditEvent(input);
    } catch {
      // Audit failure must not turn a committed shell into an ambiguous result.
    }
  }
}

/** Validate the audit envelope that must commit with a new derived shell. */
export function assertPatternMigrationAllowAudit(
  input: ArchitecturePatternMigrationAuditInput | undefined,
  actorId: string,
  targetArchitectureId: string,
): asserts input is ArchitecturePatternMigrationAuditInput {
  if (!input
    || input.actorUserId !== actorId
    || input.action !== "architecture.pattern-migration.create"
    || input.decision !== "allow"
    || input.resourceId !== targetArchitectureId
    || !isRecord(input.details ?? {})) {
    throw new AppError(
      "A valid pattern migration allow audit is required.",
      "ARCHITECTURE_PATTERN_MIGRATION_AUDIT_INVALID",
      400,
    );
  }
}

/** Explicit aliases keep the service discoverable during route composition. */
export const PatternMigrationService = ArchitecturePatternMigrationService;
export const ArchitecturePatternMigrationApplicationService = ArchitecturePatternMigrationService;

function normalizePreviewInput(input: ArchitecturePatternMigrationPreviewInput): NormalizedPreviewInput {
  const body = asRecord(input, "Pattern migration input");
  rejectUnknownKeys(body, ["actor", "architectureId", "expectedCurrentRevisionId", "targetPatternId", "mapping"]);
  const actor = body.actor as ArchitectureActorInput;
  const actorId = normalizeActorId(actor);
  const architectureId = normalizeIdentifier(body.architectureId, "architectureId");
  const expectedCurrentRevisionId = normalizeIdentifier(body.expectedCurrentRevisionId, "expectedCurrentRevisionId");
  if (typeof body.targetPatternId !== "string" || !(architecturePatternIds as readonly string[]).includes(body.targetPatternId)) {
    throw new AppError("Target pattern is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_TARGET_PATTERN_INVALID", 400);
  }
  return {
    actor,
    actorId,
    architectureId,
    expectedCurrentRevisionId,
    targetPatternId: body.targetPatternId as ArchitecturePatternId,
    ...(body.mapping === undefined ? {} : { mapping: structuredClone(body.mapping) as ArchitecturePatternMigrationMapping }),
  };
}

function normalizeCreateInput(input: ArchitecturePatternMigrationCreateInput): NormalizedCreateInput {
  const body = asRecord(input, "Pattern migration input");
  rejectUnknownKeys(body, [
    "actor",
    "architectureId",
    "expectedCurrentRevisionId",
    "targetPatternId",
    "mapping",
    "idempotencyKey",
    "name",
    "description",
    "message",
  ]);
  const preview = normalizePreviewInput({
    actor: body.actor as ArchitectureActorInput,
    architectureId: body.architectureId as string,
    expectedCurrentRevisionId: body.expectedCurrentRevisionId as string,
    targetPatternId: body.targetPatternId as ArchitecturePatternId,
    ...(body.mapping === undefined ? {} : { mapping: body.mapping as ArchitecturePatternMigrationMapping }),
  });
  const idempotencyKey = normalizeIdentifier(body.idempotencyKey, "idempotencyKey", MAX_IDEMPOTENCY_KEY_LENGTH);
  const name = normalizeText(body.name, "name", MAX_NAME_LENGTH, true);
  const description = normalizeText(body.description ?? "", "description", MAX_DESCRIPTION_LENGTH, false);
  const message = normalizeText(body.message ?? "", "message", MAX_MESSAGE_LENGTH, false);
  return { ...preview, idempotencyKey, name, description, message };
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(`${message} must be an object.`, "ARCHITECTURE_PATTERN_MIGRATION_INPUT_INVALID", 400);
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !accepted.has(key)).sort();
  if (unknown.length > 0) {
    throw new AppError("Pattern migration input contains an unsupported field.", "ARCHITECTURE_PATTERN_MIGRATION_INPUT_UNKNOWN_FIELD", 400, { fields: unknown });
  }
}

function normalizeIdentifier(value: unknown, field: string, maxLength = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !IDENTIFIER_PATTERN.test(value)) {
    throw new AppError(`${field} is invalid.`, "ARCHITECTURE_PATTERN_MIGRATION_IDENTIFIER_INVALID", 400);
  }
  return value;
}

function normalizeActorId(input: ArchitectureActorInput): string {
  const value = typeof input === "string" ? input : input && typeof input === "object"
    ? ("id" in input && typeof input.id === "string" ? input.id : "userId" in input && typeof input.userId === "string" ? input.userId : undefined)
    : undefined;
  if (!value || (typeof input !== "string" && "id" in input && "userId" in input && input.id !== undefined && input.userId !== undefined && input.id !== input.userId)) {
    throw new AppError("Pattern migration actor is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_ACTOR_INVALID", 400);
  }
  return normalizeIdentifier(value, "actorId");
}

function normalizeText(value: unknown, field: string, maxLength: number, required: boolean): string {
  if (typeof value !== "string") {
    throw new AppError(`${field} is invalid.`, "ARCHITECTURE_PATTERN_MIGRATION_METADATA_INVALID", 400);
  }
  const normalized = value.trim();
  if ((required && normalized.length === 0) || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new AppError(`${field} is invalid.`, "ARCHITECTURE_PATTERN_MIGRATION_METADATA_INVALID", 400);
  }
  return normalized;
}

function boundedResultBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RESULT_BYTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1024 * 1024) {
    throw new AppError("Pattern migration result bound is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_LIMIT_INVALID", 500);
  }
  return value;
}

function cloneAccess(access: ArchitectureRecord["access"]): ArchitectureRecord["access"] {
  return structuredClone(access);
}

function sameOwner(left: ArchitectureOwnerReference, right: ArchitectureOwnerReference): boolean {
  return left.type === right.type && left.id === right.id;
}

function ownerAccessMetadata(
  owner: ArchitectureOwnerReference,
  accessPolicyVersion: number,
): ArchitectureRecord["access"] {
  return {
    owner: { ...owner },
    ownerType: owner.type,
    ownerId: owner.id,
    policyVersion: accessPolicyVersion,
    accessPolicyVersion,
    role: "owner",
    canList: true,
    canRead: true,
    canPreview: true,
    canCreate: true,
    canAppend: true,
    canManage: true,
    reasons: [owner.type === "user" ? "owner" : "team-owner"],
    allowedOrganizationIds: [],
  };
}

function migrationFromCandidate(
  candidate: Omit<ArchitecturePatternMigrationCreateStoreInput, "actorId" | "expectedCurrentRevisionId" | "sourceArchitecture" | "sourceRevision" | "audit" | "intentDigest">,
  migration: Extract<ArchitecturePatternMigrationResult, { target: { patternId: ArchitecturePatternId } }>,
): ArchitecturePatternMigrationResult {
  return {
    ...structuredClone(migration),
    target: {
      patternId: candidate.lineage.targetPatternId,
      spec: structuredClone(candidate.targetRevision.spec),
      revisionDigest: candidate.lineage.targetRevisionDigest,
    },
    migrationDigest: candidate.lineage.migrationDigest,
    diffDigest: candidate.lineage.diffDigest,
  };
}

function migrationIntentDigest(input: {
  actorId: string;
  sourceArchitectureId: string;
  sourceRevisionId: string;
  expectedCurrentRevisionId: string;
  owner: ArchitectureOwnerReference;
  sourceRevisionDigest: string;
  targetPatternId: ArchitecturePatternId;
  mapping?: ArchitecturePatternMigrationMapping;
  name: string;
  description: string;
  message: string;
}): string {
  return sha256Hex(canonicalizeJson({
    actorId: input.actorId,
    sourceArchitectureId: input.sourceArchitectureId,
    sourceRevisionId: input.sourceRevisionId,
    expectedCurrentRevisionId: input.expectedCurrentRevisionId,
    owner: input.owner,
    sourceRevisionDigest: input.sourceRevisionDigest,
    targetPatternId: input.targetPatternId,
    mapping: input.mapping === undefined || Object.keys(input.mapping).length === 0 ? null : input.mapping,
    name: input.name,
    description: input.description,
    message: input.message,
  }));
}

function migrationIntentDigestFromRecord(
  record: ArchitecturePatternMigrationPersistedRecord,
): string {
  return migrationIntentDigest({
    actorId: record.lineage.actorUserId,
    sourceArchitectureId: record.lineage.sourceArchitectureId,
    sourceRevisionId: record.lineage.sourceRevisionId,
    expectedCurrentRevisionId: record.lineage.sourceRevisionId,
    owner: record.targetArchitecture.owner,
    sourceRevisionDigest: record.lineage.sourceRevisionDigest,
    targetPatternId: record.lineage.targetPatternId,
    mapping: Object.keys(record.lineage.mapping).length === 0 ? undefined : record.lineage.mapping,
    name: record.targetArchitecture.name,
    description: record.targetArchitecture.description,
    message: record.targetRevision.message,
  });
}

function migrationAuditDetails(input: {
  sourceArchitectureId: string;
  sourceRevisionId: string;
  sourcePatternId: ArchitecturePatternId;
  targetPatternId: ArchitecturePatternId;
  targetArchitectureId?: string;
  targetRevisionId?: string;
  sourceRevisionDigest?: string;
  targetRevisionDigest?: string;
  migrationDigest?: string;
  diffDigest?: string;
  code: string;
  diff?: ArchitecturePatternMigrationDiff;
}): Record<string, unknown> {
  const details: Record<string, unknown> = {
    sourceArchitectureId: input.sourceArchitectureId,
    sourceRevisionId: input.sourceRevisionId,
    sourcePatternId: input.sourcePatternId,
    targetPatternId: input.targetPatternId,
    code: safeCode(input.code) ?? "pattern-migration.event",
  };
  if (input.targetArchitectureId) details.targetArchitectureId = input.targetArchitectureId;
  if (input.targetRevisionId) details.targetRevisionId = input.targetRevisionId;
  if (input.sourceRevisionDigest && DIGEST_PATTERN.test(input.sourceRevisionDigest)) details.sourceRevisionDigest = input.sourceRevisionDigest;
  if (input.targetRevisionDigest && DIGEST_PATTERN.test(input.targetRevisionDigest)) details.targetRevisionDigest = input.targetRevisionDigest;
  if (input.migrationDigest && DIGEST_PATTERN.test(input.migrationDigest)) details.migrationDigest = input.migrationDigest;
  if (input.diffDigest && DIGEST_PATTERN.test(input.diffDigest)) details.diffDigest = input.diffDigest;
  if (input.diff) {
    details.preservedSkillRefCount = input.diff.preservedSkillRefIds.length;
    details.preservedLeafNodeCount = input.diff.preservedLeafNodeIds.length;
    details.addedRouterNodeCount = input.diff.addedRouterNodeIds.length;
    details.droppedRouterNodeCount = input.diff.droppedRouterNodeIds.length;
    details.addedEdgeCount = input.diff.addedEdgeCount;
    details.removedEdgeCount = input.diff.removedEdgeCount;
    details.rewrittenBindingCount = input.diff.rewrittenBindingCount;
  }
  return sanitizeAuditDetails(details);
}

function issueCode(issues: readonly ArchitecturePatternMigrationIssue[]): string {
  return safeCode(issues[0]?.code) ?? "pattern-migration.blocked";
}

function safeCode(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) return undefined;
  return value;
}

function errorCode(error: unknown, fallback: string): string {
  if (error instanceof AppError && safeCode(error.code)) return error.code;
  return fallback;
}
