import { randomUUID } from "node:crypto";
import {
  AppError,
  architectureDigest,
  architecturePatternIds,
  architecturePatternMigrationDiffDigest,
  architecturePatternMigrationDigest,
  assertValidArchitectureSpec,
  canonicalizeJson,
} from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import {
  assertPatternMigrationAllowAudit,
  type ArchitecturePatternMigrationAuditEvent,
  type ArchitecturePatternMigrationAuditInput,
  type ArchitecturePatternMigrationCreateStoreInput,
  type ArchitecturePatternMigrationCreateStoreResult,
  type ArchitecturePatternMigrationLineage,
  type ArchitecturePatternMigrationArchitectureAggregate,
  type ArchitecturePatternMigrationPersistedRecord,
  type ArchitecturePatternMigrationStore,
} from "./pattern-migration-service.js";
import {
  assertArchitectureSpecSize,
  MAX_REVISIONS_PER_ARCHITECTURE,
  validateArchitectureSpec,
} from "./service.js";
import {
  normalizeArchitectureActor,
  type ArchitectureActorInput,
  type ArchitectureAuditEvent,
  type ArchitectureAuditInput,
  type ArchitectureRecord,
  type ArchitectureRevisionRecord,
  type ArchitectureStore,
  type CreateArchitectureInput,
  type CreateArchitectureRevisionInput,
} from "./types.js";

interface StoredPatternMigration extends ArchitecturePatternMigrationPersistedRecord {
  /** Used only inside the repository to enforce actor/key replay identity. */
  intentDigest: string;
}

export interface MemoryPatternMigrationStoreOptions {
  now?: () => Date;
  /** Called before the commit point. Throwing must leave all maps unchanged. */
  beforeCommit?: (input: ArchitecturePatternMigrationCreateStoreInput) => void;
  /** Called immediately before the required allow audit is committed. */
  beforeAuditInsert?: (input: ArchitecturePatternMigrationAuditInput) => void | Promise<void>;
  /** Canonical source store used for commit-time source revision revalidation. */
  sourceStore?: ArchitectureStore;
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_MAPPING_BYTES = 32_768;
const AUDIT_DETAIL_KEYS = new Set([
  "sourceArchitectureId",
  "sourceRevisionId",
  "sourcePatternId",
  "targetPatternId",
  "targetArchitectureId",
  "targetRevisionId",
  "sourceRevisionDigest",
  "targetRevisionDigest",
  "migrationDigest",
  "diffDigest",
  "code",
  "preservedSkillRefCount",
  "preservedLeafNodeCount",
  "addedRouterNodeCount",
  "droppedRouterNodeCount",
  "addedEdgeCount",
  "removedEdgeCount",
  "rewrittenBindingCount",
]);

/**
 * Deterministic, append-only memory repository for the pattern migration
 * transaction. It binds to the canonical source ArchitectureStore for
 * commit-time source revision revalidation; it never copies source state.
 */
export class MemoryPatternMigrationStore implements ArchitecturePatternMigrationStore {
  readonly kind = "memory" as const;

  private readonly migrations = new Map<string, StoredPatternMigration>();
  private readonly byIdempotency = new Map<string, StoredPatternMigration>();
  private readonly targetRevisions = new Map<string, ArchitectureRevisionRecord[]>();
  private readonly audits: ArchitecturePatternMigrationAuditEvent[] = [];
  private readonly now: () => Date;
  private beforeCommit?: (input: ArchitecturePatternMigrationCreateStoreInput) => void;
  private beforeAuditInsert?: (input: ArchitecturePatternMigrationAuditInput) => void | Promise<void>;
  private sourceStore?: ArchitectureStore;
  private nextAuditNumber = 1;
  private createCommitTail: Promise<void> = Promise.resolve();

  constructor(options: MemoryPatternMigrationStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.beforeCommit = options.beforeCommit;
    this.beforeAuditInsert = options.beforeAuditInsert;
    this.sourceStore = options.sourceStore;
  }

  bindSourceStore(sourceStore: ArchitectureStore): void {
    this.sourceStore = sourceStore;
  }

  /** Install a deterministic failure before the atomic commit point in tests. */
  setBeforeCommitFailure(callback?: (input: ArchitecturePatternMigrationCreateStoreInput) => void): void {
    this.beforeCommit = callback;
  }

  async getByIdempotencyKey(actorId: string, idempotencyKey: string): Promise<ArchitecturePatternMigrationPersistedRecord | null> {
    const existing = this.byIdempotency.get(idempotencyKeyKey(actorId, idempotencyKey));
    return existing ? clonePublicRecord(existing) : null;
  }

  /**
   * Validate and commit all three records as one in-memory operation. Every
   * validation and injectable failure runs before any map is changed.
   */
  async createDerivedShell(input: ArchitecturePatternMigrationCreateStoreInput): Promise<ArchitecturePatternMigrationCreateStoreResult> {
    const previous = this.createCommitTail;
    let release!: () => void;
    this.createCommitTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.createDerivedShellLocked(input);
    } finally {
      release();
    }
  }

  private async createDerivedShellLocked(input: ArchitecturePatternMigrationCreateStoreInput): Promise<ArchitecturePatternMigrationCreateStoreResult> {
    const authoritativeInput = await this.revalidateSource(input);
    validateCreateInput(authoritativeInput);
    assertPatternMigrationAllowAudit(authoritativeInput.audit, authoritativeInput.actorId, authoritativeInput.targetArchitecture.id);
    const key = idempotencyKeyKey(authoritativeInput.actorId, authoritativeInput.lineage.idempotencyKey);
    const existing = this.byIdempotency.get(key);
    if (existing) {
      if (existing.intentDigest !== authoritativeInput.intentDigest) {
        throw new AppError(
          "This idempotency key was already used for a different pattern migration.",
          "ARCHITECTURE_PATTERN_MIGRATION_IDEMPOTENCY_CONFLICT",
          409,
        );
      }
      return { record: clonePublicRecord(existing), replayed: true };
    }
    if (this.migrations.has(authoritativeInput.lineage.targetArchitectureId)) {
      throw new AppError("The derived architecture already exists.", "ARCHITECTURE_PATTERN_MIGRATION_TARGET_EXISTS", 409);
    }
    if ([...this.migrations.values()].some((candidate) => candidate.lineage.targetRevisionId === authoritativeInput.lineage.targetRevisionId)) {
      throw new AppError("The derived architecture revision already exists.", "ARCHITECTURE_PATTERN_MIGRATION_TARGET_REVISION_EXISTS", 409);
    }

    // This is the only failure hook and it runs before the commit point. A
    // thrown error therefore proves atomic no-partial-state behavior.
    const audit = this.createAuditEvent(authoritativeInput.audit);
    this.beforeCommit?.(authoritativeInput);
    await this.beforeAuditInsert?.(authoritativeInput.audit);

    const stored: StoredPatternMigration = {
      targetArchitecture: structuredClone(authoritativeInput.targetArchitecture),
      targetRevision: structuredClone(authoritativeInput.targetRevision),
      lineage: structuredClone(authoritativeInput.lineage),
      intentDigest: authoritativeInput.intentDigest,
    };
    this.migrations.set(stored.lineage.targetArchitectureId, stored);
    this.byIdempotency.set(key, stored);
    this.targetRevisions.set(stored.lineage.targetArchitectureId, [structuredClone(stored.targetRevision)]);
    this.audits.push(audit);
    this.nextAuditNumber += 1;
    return { record: clonePublicRecord(stored), replayed: false };
  }

  /** Alias for repository callers that use the full operation name. */
  async createPatternMigration(input: ArchitecturePatternMigrationCreateStoreInput): Promise<ArchitecturePatternMigrationCreateStoreResult> {
    return this.createDerivedShell(input);
  }

  /**
   * Compose this journal with the canonical ArchitectureStore read/write
   * boundary. The returned aggregate delegates source operations and overlays
   * committed migration shells, so list/get callers observe exactly the same
   * target IDs returned by the migration create operation. Target sharing is
   * owner-only until an explicit policy-bound grant is created.
   */
  asArchitectureStore(sourceStore: ArchitectureStore): ArchitecturePatternMigrationArchitectureAggregate {
    this.bindSourceStore(sourceStore);
    return new MemoryPatternMigrationArchitectureAggregate(sourceStore, this);
  }

  async getMigration(targetArchitectureId: string): Promise<ArchitecturePatternMigrationPersistedRecord | null> {
    const record = this.migrations.get(targetArchitectureId);
    return record ? clonePublicRecord(record) : null;
  }

  async getTargetArchitecture(targetArchitectureId: string) {
    return (await this.getMigration(targetArchitectureId))?.targetArchitecture ?? null;
  }

  async getTargetRevision(targetArchitectureId: string) {
    const revisions = this.targetRevisions.get(targetArchitectureId);
    if (revisions?.length) return structuredClone(revisions.at(-1)!);
    return (await this.getMigration(targetArchitectureId))?.targetRevision ?? null;
  }

  async listTargetRevisions(targetArchitectureId: string): Promise<ArchitectureRevisionRecord[]> {
    const revisions = this.targetRevisions.get(targetArchitectureId);
    return revisions ? revisions.slice().reverse().map((revision) => structuredClone(revision)) : [];
  }

  async createDerivedRevision(
    actorInput: ArchitectureActorInput,
    input: CreateArchitectureRevisionInput,
  ): Promise<ArchitectureRevisionRecord | null> {
    const record = this.migrations.get(input.architectureId);
    if (!record || !this.sourceStore) return null;
    const target = await accessibleTargetArchitecture(record, actorInput, this.sourceStore);
    if (!target || !target.access.canAppend || !target.access.canManage || !target.access.canCreate) return null;
    const revisions = this.targetRevisions.get(input.architectureId) ?? [structuredClone(record.targetRevision)];
    if (input.expectedCurrentRevisionId !== target.currentRevisionId) {
      throw new AppError(
        "The architecture changed after this draft was opened.",
        "ARCHITECTURE_REVISION_CONFLICT",
        409,
        { currentRevisionId: target.currentRevisionId },
      );
    }
    if (revisions.length >= MAX_REVISIONS_PER_ARCHITECTURE) {
      throw new AppError(
        `An architecture may contain at most ${MAX_REVISIONS_PER_ARCHITECTURE} revisions.`,
        "ARCHITECTURE_REVISION_QUOTA_EXCEEDED",
        409,
      );
    }
    const actor = normalizeArchitectureActor(actorInput);
    const spec = validateArchitectureSpec(input.spec, target.patternId);
    assertArchitectureSpecSize(spec);
    if (spec.id !== input.architectureId) {
      throw new AppError(
        "Revision specification must identify its architecture.",
        "ARCHITECTURE_REVISION_TARGET_INVALID",
        409,
      );
    }
    const now = new Date().toISOString();
    const revision: ArchitectureRevisionRecord = {
      id: `revision-${revisions.length + 1}-${randomUUID().slice(0, 8)}`,
      architectureId: input.architectureId,
      revisionNumber: revisions.length + 1,
      message: input.message,
      spec: structuredClone(spec),
      createdByUserId: actor.id,
      createdAt: now,
      access: structuredClone(target.access),
    };
    revisions.push(revision);
    this.targetRevisions.set(input.architectureId, revisions);
    record.targetArchitecture.currentRevisionId = revision.id;
    record.targetArchitecture.revisionCount = revision.revisionNumber;
    record.targetArchitecture.updatedAt = now;
    return structuredClone(revision);
  }

  async getLineage(targetArchitectureId: string): Promise<ArchitecturePatternMigrationLineage | null> {
    return (await this.getMigration(targetArchitectureId))?.lineage ?? null;
  }

  async listMigrations(): Promise<ArchitecturePatternMigrationPersistedRecord[]> {
    return [...this.migrations.values()]
      .sort((left, right) => right.lineage.createdAt.localeCompare(left.lineage.createdAt) || right.lineage.id.localeCompare(left.lineage.id))
      .map(clonePublicRecord);
  }

  async recordAuditEvent(input: ArchitecturePatternMigrationAuditInput): Promise<void> {
    this.audits.push(this.createAuditEvent(input));
    this.nextAuditNumber += 1;
  }

  async listAuditEvents(limit = 100): Promise<ArchitecturePatternMigrationAuditEvent[]> {
    const bounded = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 100;
    return this.audits.slice(-bounded).reverse().map((event) => ({
      ...event,
      details: structuredClone(event.details),
    }));
  }

  get migrationCount(): number {
    return this.migrations.size;
  }

  private createAuditEvent(input: ArchitecturePatternMigrationAuditInput): ArchitecturePatternMigrationAuditEvent {
    return {
      id: `architecture-pattern-migration-audit-${this.nextAuditNumber}`,
      actorUserId: input.actorUserId,
      action: input.action,
      decision: input.decision,
      resourceId: input.resourceId ?? null,
      details: sanitizeMigrationAuditDetails(input.details ?? {}),
      createdAt: this.now().toISOString(),
    };
  }

  private async revalidateSource(input: ArchitecturePatternMigrationCreateStoreInput): Promise<ArchitecturePatternMigrationCreateStoreInput> {
    if (!this.sourceStore) return input;
    const sourceArchitecture = await this.sourceStore.getArchitecture(input.actorId, input.sourceArchitecture.id);
    if (!sourceArchitecture || sourceArchitecture.currentRevisionId !== input.expectedCurrentRevisionId) {
      throw new AppError(
        "The architecture changed after this migration was opened.",
        "ARCHITECTURE_PATTERN_MIGRATION_REVISION_CONFLICT",
        409,
        { currentRevisionId: sourceArchitecture?.currentRevisionId ?? null },
      );
    }
    const sourceRevision = await this.sourceStore.getRevision(
      input.actorId,
      sourceArchitecture.id,
      input.expectedCurrentRevisionId,
    );
    if (!sourceRevision || sourceRevision.id !== input.expectedCurrentRevisionId) {
      throw new AppError(
        "The architecture changed after this migration was opened.",
        "ARCHITECTURE_PATTERN_MIGRATION_REVISION_CONFLICT",
        409,
        { currentRevisionId: sourceArchitecture.currentRevisionId },
      );
    }
    const currentArchitecture = await this.sourceStore.getArchitecture(input.actorId, input.sourceArchitecture.id);
    if (!currentArchitecture || currentArchitecture.currentRevisionId !== input.expectedCurrentRevisionId) {
      throw new AppError(
        "The architecture changed after this migration was opened.",
        "ARCHITECTURE_PATTERN_MIGRATION_REVISION_CONFLICT",
        409,
        { currentRevisionId: currentArchitecture?.currentRevisionId ?? null },
      );
    }
    if (architectureDigest(sourceRevision.spec) !== input.lineage.sourceRevisionDigest) {
      throw new AppError(
        "Source revision digest does not match the authoritative source.",
        "ARCHITECTURE_PATTERN_MIGRATION_DIGEST_CONFLICT",
        409,
      );
    }
    return {
      ...input,
      sourceArchitecture: structuredClone(currentArchitecture),
      sourceRevision: structuredClone(sourceRevision),
    };
  }
}

export const MemoryArchitecturePatternMigrationStore = MemoryPatternMigrationStore;

/**
 * Read/write aggregate used by memory fixtures and local API composition.
 * Source operations remain delegated to the canonical architecture store;
 * target records become visible only after the migration journal's atomic
 * commit. This is the explicit adapter boundary that a route must wire as
 * its ArchitectureStore when it uses MemoryPatternMigrationStore.
 */
export class MemoryPatternMigrationArchitectureAggregate implements ArchitecturePatternMigrationArchitectureAggregate {
  readonly kind: ArchitectureStore["kind"];
  readonly patternMigrationStore: ArchitecturePatternMigrationStore;

  constructor(
    private readonly sourceStore: ArchitectureStore,
    private readonly migrationStore: MemoryPatternMigrationStore,
  ) {
    this.kind = sourceStore.kind;
    this.patternMigrationStore = migrationStore;
  }

  async listArchitectures(actor: ArchitectureActorInput): Promise<ArchitectureRecord[]> {
    const source = await this.sourceStore.listArchitectures(actor);
    const derived = (await Promise.all((await this.migrationStore.listMigrations()).map((record) => (
      accessibleTargetArchitecture(record, actor, this.sourceStore)
    )))).filter((record): record is ArchitectureRecord => record !== null);
    return [...source, ...derived]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .slice(0, 500);
  }

  async getArchitecture(actor: ArchitectureActorInput, architectureId: string): Promise<ArchitectureRecord | null> {
    const source = await this.sourceStore.getArchitecture(actor, architectureId);
    if (source) return source;
    const record = await this.migrationStore.getMigration(architectureId);
    return record ? accessibleTargetArchitecture(record, actor, this.sourceStore) : null;
  }

  async listRevisions(actor: ArchitectureActorInput, architectureId: string): Promise<ArchitectureRevisionRecord[] | null> {
    const source = await this.sourceStore.listRevisions(actor, architectureId);
    if (source) return source;
    const record = await this.migrationStore.getMigration(architectureId);
    if (!record) return null;
    const target = await accessibleTargetArchitecture(record, actor, this.sourceStore);
    if (!target) return null;
    const access = target.access;
    if (!access.canRead) return null;
    const revisions = await this.migrationStore.listTargetRevisions(architectureId);
    return revisions.map((revision) => ({ ...revision, access: structuredClone(access) }));
  }

  async getRevision(
    actor: ArchitectureActorInput,
    architectureId: string,
    revisionId?: string,
  ): Promise<ArchitectureRevisionRecord | null> {
    const source = await this.sourceStore.getRevision(actor, architectureId, revisionId);
    if (source) return source;
    const record = await this.migrationStore.getMigration(architectureId);
    if (!record) return null;
    const target = await accessibleTargetArchitecture(record, actor, this.sourceStore);
    if (!target) return null;
    const access = target.access;
    if (!access.canRead) return null;
    const revision = revisionId === undefined
      ? await this.migrationStore.getTargetRevision(architectureId)
      : (await this.migrationStore.listTargetRevisions(architectureId)).find((candidate) => candidate.id === revisionId) ?? null;
    if (!revision) return null;
    return {
      ...revision,
      access: structuredClone(access),
    };
  }

  async getRevisionForPreview(
    actor: ArchitectureActorInput,
    architectureId: string,
    revisionId?: string,
    organizationId?: string | null,
  ): Promise<ArchitectureRevisionRecord | null> {
    const source = await this.sourceStore.getRevisionForPreview(actor, architectureId, revisionId, organizationId);
    if (source) return source;
    const record = await this.migrationStore.getMigration(architectureId);
    if (!record) return null;
    const target = await accessibleTargetArchitecture(record, actor, this.sourceStore);
    if (!target) return null;
    const access = target.access;
    if (!access.canPreview) return null;
    const revision = revisionId === undefined
      ? await this.migrationStore.getTargetRevision(architectureId)
      : (await this.migrationStore.listTargetRevisions(architectureId)).find((candidate) => candidate.id === revisionId) ?? null;
    if (!revision) return null;
    return {
      ...revision,
      access: structuredClone(access),
    };
  }

  async createArchitecture(input: CreateArchitectureInput): Promise<ArchitectureRecord>;
  async createArchitecture(actor: ArchitectureActorInput, input: CreateArchitectureInput, audit?: ArchitectureAuditInput): Promise<ArchitectureRecord>;
  async createArchitecture(
    first: CreateArchitectureInput | ArchitectureActorInput,
    second?: CreateArchitectureInput,
    audit?: ArchitectureAuditInput,
  ): Promise<ArchitectureRecord> {
    return second === undefined
      ? this.sourceStore.createArchitecture(first as CreateArchitectureInput)
      : this.sourceStore.createArchitecture(first as ArchitectureActorInput, second, audit);
  }

  async createRevision(input: CreateArchitectureRevisionInput): Promise<ArchitectureRevisionRecord | null>;
  async createRevision(actor: ArchitectureActorInput, input: CreateArchitectureRevisionInput, audit?: ArchitectureAuditInput): Promise<ArchitectureRevisionRecord | null>;
  async createRevision(
    first: CreateArchitectureRevisionInput | ArchitectureActorInput,
    second?: CreateArchitectureRevisionInput,
    audit?: ArchitectureAuditInput,
  ): Promise<ArchitectureRevisionRecord | null> {
    const input = second === undefined ? first as CreateArchitectureRevisionInput : second;
    const actor = second === undefined ? input.actor ?? input.ownerUserId ?? "" : first as ArchitectureActorInput;
    const source = await this.sourceStore.getArchitecture(actor, input.architectureId);
    if (source) {
      return second === undefined
        ? this.sourceStore.createRevision(input)
        : this.sourceStore.createRevision(actor, input, audit);
    }
    const record = await this.migrationStore.getMigration(input.architectureId);
    if (!record) return null;
    // Derived shells are owned by the migration aggregate after creation;
    // append through its revision journal so current pointers and history do
    // not disappear behind the source-only store.
    return this.migrationStore.createDerivedRevision(actor, input);
  }

  async recordAuditEvent(input: ArchitectureAuditInput): Promise<void> {
    return this.sourceStore.recordAuditEvent(input);
  }

  async listAuditEvents(limit?: number): Promise<ArchitectureAuditEvent[]> {
    return this.sourceStore.listAuditEvents(limit);
  }
}

async function accessibleTargetArchitecture(
  record: ArchitecturePatternMigrationPersistedRecord,
  actor: ArchitectureActorInput,
  sourceStore: ArchitectureStore,
): Promise<ArchitectureRecord | null> {
  // Resolve current source access through the canonical store so team
  // membership changes are reflected. Organization-only readers never gain
  // access to the derived shell because no source grant is copied.
  const source = await sourceStore.getArchitecture(actor, record.lineage.sourceArchitectureId);
  if (!source || !source.access.canRead || source.access.reasons.includes("organization")) return null;
  const target = structuredClone(record.targetArchitecture);
  const access = {
    ...structuredClone(source.access),
    owner: { ...target.owner },
    ownerType: target.owner.type,
    ownerId: target.owner.id,
    allowedOrganizationIds: [],
  };
  return access.canRead ? { ...target, access } : null;
}

function validateCreateInput(input: ArchitecturePatternMigrationCreateStoreInput): void {
  if (!input || typeof input !== "object") throw new AppError("Pattern migration persistence input is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_STORE_INPUT_INVALID", 400);
  if (
    !isRecord(input.sourceArchitecture)
    || !isRecord(input.sourceRevision)
    || !isRecord(input.targetArchitecture)
    || !isRecord(input.targetRevision)
    || !isRecord(input.lineage)
    || !isRecord(input.sourceArchitecture.owner)
    || !isRecord(input.targetArchitecture.owner)
    || !isRecord(input.sourceRevision.spec)
    || !isRecord(input.targetRevision.spec)
    || !isRecord(input.targetArchitecture.access)
    || !Array.isArray(input.targetArchitecture.access.allowedOrganizationIds)
  ) {
    throw new AppError("Pattern migration persistence input is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_STORE_INPUT_INVALID", 400);
  }
  if (!IDENTIFIER_PATTERN.test(input.actorId)) throw new AppError("Pattern migration actor is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_ACTOR_INVALID", 400);
  if (!IDENTIFIER_PATTERN.test(input.expectedCurrentRevisionId)) throw new AppError("Expected source revision is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_REVISION_INVALID", 400);
  const identities = [
    input.sourceArchitecture?.id,
    input.sourceRevision?.id,
    input.targetArchitecture?.id,
    input.targetRevision?.id,
    input.lineage?.id,
    input.lineage?.sourceArchitectureId,
    input.lineage?.sourceRevisionId,
    input.lineage?.targetArchitectureId,
    input.lineage?.targetRevisionId,
    input.lineage?.actorUserId,
  ];
  if (identities.some((value) => typeof value !== "string" || !IDENTIFIER_PATTERN.test(value))) {
    throw new AppError("Pattern migration identities are invalid.", "ARCHITECTURE_PATTERN_MIGRATION_IDENTIFIER_INVALID", 400);
  }
  if (input.sourceArchitecture.currentRevisionId !== input.expectedCurrentRevisionId || input.sourceRevision.id !== input.expectedCurrentRevisionId) {
    throw new AppError(
      "The source architecture changed after this migration was opened.",
      "ARCHITECTURE_PATTERN_MIGRATION_REVISION_CONFLICT",
      409,
      { currentRevisionId: input.sourceArchitecture.currentRevisionId },
    );
  }
  if (input.sourceRevision.architectureId !== input.sourceArchitecture.id || input.sourceRevision.spec.id !== input.sourceArchitecture.id) {
    throw new AppError("Source architecture and revision identities do not match.", "ARCHITECTURE_PATTERN_MIGRATION_SOURCE_INVALID", 409);
  }
  if (input.sourceRevision.spec.pattern.id !== input.sourceArchitecture.patternId) {
    throw new AppError("Source architecture pattern is immutable and must match its current revision.", "ARCHITECTURE_PATTERN_MIGRATION_SOURCE_INVALID", 409);
  }
  if (!(architecturePatternIds as readonly string[]).includes(input.sourceArchitecture.patternId)) {
    throw new AppError("Source architecture pattern is unsupported.", "ARCHITECTURE_PATTERN_MIGRATION_SOURCE_INVALID", 409);
  }
  if (input.targetArchitecture.id !== input.lineage.targetArchitectureId || input.targetRevision.id !== input.lineage.targetRevisionId) {
    throw new AppError("Derived shell and lineage identities do not match.", "ARCHITECTURE_PATTERN_MIGRATION_TARGET_INVALID", 409);
  }
  if (input.targetRevision.architectureId !== input.targetArchitecture.id || input.targetArchitecture.currentRevisionId !== input.targetRevision.id || input.targetArchitecture.revisionCount !== 1 || input.targetRevision.revisionNumber !== 1) {
    throw new AppError("A pattern migration must create exactly one first revision for its new shell.", "ARCHITECTURE_PATTERN_MIGRATION_TARGET_INVALID", 409);
  }
  if (input.sourceArchitecture.id === input.targetArchitecture.id) {
    throw new AppError("A pattern migration target must be a new architecture shell.", "ARCHITECTURE_PATTERN_MIGRATION_TARGET_INVALID", 409);
  }
  if (!sameOwner(input.sourceArchitecture.owner, input.targetArchitecture.owner)) {
    throw new AppError("A derived shell must retain the source owner.", "ARCHITECTURE_PATTERN_MIGRATION_OWNER_INVALID", 409);
  }
  if (
    input.targetArchitecture.ownerType !== input.targetArchitecture.owner.type
    || input.targetArchitecture.ownerId !== input.targetArchitecture.owner.id
    || (input.targetArchitecture.owner.type === "user"
      ? input.targetArchitecture.ownerUserId !== input.targetArchitecture.owner.id || input.targetArchitecture.ownerTeamId !== null
      : input.targetArchitecture.ownerTeamId !== input.targetArchitecture.owner.id || input.targetArchitecture.ownerUserId !== null)
  ) {
    throw new AppError("Derived shell owner metadata is inconsistent.", "ARCHITECTURE_PATTERN_MIGRATION_OWNER_INVALID", 409);
  }
  if (input.targetArchitecture.access.allowedOrganizationIds.length > 0) {
    throw new AppError("A derived shell cannot copy source organization grants.", "ARCHITECTURE_PATTERN_MIGRATION_GRANT_COPY_FORBIDDEN", 409);
  }
  if (input.targetArchitecture.patternId !== input.lineage.targetPatternId || input.targetRevision.spec.pattern.id !== input.lineage.targetPatternId) {
    throw new AppError("Derived target pattern metadata is inconsistent.", "ARCHITECTURE_PATTERN_MIGRATION_TARGET_INVALID", 409);
  }
  if (!(architecturePatternIds as readonly string[]).includes(input.lineage.targetPatternId)) {
    throw new AppError("Derived target pattern is unsupported.", "ARCHITECTURE_PATTERN_MIGRATION_TARGET_INVALID", 409);
  }
  if (input.targetRevision.spec.id !== input.targetArchitecture.id || input.targetRevision.spec.name !== input.targetArchitecture.name || (input.targetRevision.spec.description ?? "") !== (input.targetArchitecture.description || "")) {
    throw new AppError("Derived shell metadata must be authoritative in the first revision.", "ARCHITECTURE_PATTERN_MIGRATION_TARGET_INVALID", 409);
  }
  if (input.lineage.sourceArchitectureId !== input.sourceArchitecture.id || input.lineage.sourceRevisionId !== input.sourceRevision.id || input.lineage.targetArchitectureId !== input.targetArchitecture.id || input.lineage.targetRevisionId !== input.targetRevision.id || input.lineage.actorUserId !== input.actorId || input.lineage.mode !== "derive-shell" || input.lineage.schemaVersion !== 1) {
    throw new AppError("Pattern migration lineage identities are inconsistent.", "ARCHITECTURE_PATTERN_MIGRATION_LINEAGE_INVALID", 409);
  }
  if (input.lineage.sourcePatternId !== input.sourceRevision.spec.pattern.id) {
    throw new AppError("Pattern migration lineage source pattern is inconsistent.", "ARCHITECTURE_PATTERN_MIGRATION_LINEAGE_INVALID", 409);
  }
  if (!["deterministic", "fallback", "provided"].includes(input.lineage.mappingStatus)) {
    throw new AppError("Pattern migration lineage mapping status is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_LINEAGE_INVALID", 400);
  }
  if (!DIGEST_PATTERN.test(input.lineage.sourceRevisionDigest) || architectureDigest(input.sourceRevision.spec) !== input.lineage.sourceRevisionDigest) {
    throw new AppError("Source revision digest does not match the authoritative source.", "ARCHITECTURE_PATTERN_MIGRATION_DIGEST_CONFLICT", 409);
  }
  if (!DIGEST_PATTERN.test(input.lineage.targetRevisionDigest) || architectureDigest(input.targetRevision.spec) !== input.lineage.targetRevisionDigest) {
    throw new AppError("Target revision digest does not match the derived revision.", "ARCHITECTURE_PATTERN_MIGRATION_DIGEST_CONFLICT", 409);
  }
  if (architecturePatternMigrationDigest({
    schemaVersion: 1,
    mode: "derive-shell",
    source: {
      architectureId: input.lineage.sourceArchitectureId,
      patternId: input.lineage.sourcePatternId,
      revisionDigest: input.lineage.sourceRevisionDigest,
    },
    target: {
      patternId: input.lineage.targetPatternId,
      spec: input.targetRevision.spec,
      revisionDigest: input.lineage.targetRevisionDigest,
    },
    mappingStatus: input.lineage.mappingStatus,
    diff: input.lineage.diff,
    issues: [],
    migrationDigest: "",
    diffDigest: input.lineage.diffDigest,
  }) !== input.lineage.migrationDigest) {
    throw new AppError("Pattern migration digest does not match the derived result.", "ARCHITECTURE_PATTERN_MIGRATION_DIGEST_CONFLICT", 409);
  }
  if (
    !DIGEST_PATTERN.test(input.lineage.diffDigest)
    || architecturePatternMigrationDiffDigest(input.lineage.diff) !== input.lineage.diffDigest
    || !IDENTIFIER_PATTERN.test(input.lineage.idempotencyKey)
    || !DIGEST_PATTERN.test(input.intentDigest)
  ) {
    throw new AppError("Pattern migration lineage digest or idempotency key is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_LINEAGE_INVALID", 400);
  }
  try {
    if (canonicalizeJson(input.lineage.mapping).length > MAX_MAPPING_BYTES) {
      throw new AppError("Pattern migration mapping is too large.", "ARCHITECTURE_PATTERN_MIGRATION_LIMIT_EXCEEDED", 413);
    }
    assertValidArchitectureSpec(input.targetRevision.spec);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Derived architecture revision is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_TARGET_INVALID", 422);
  }
}

function sameOwner(left: { type: string; id: string }, right: { type: string; id: string }): boolean {
  return left.type === right.type && left.id === right.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function idempotencyKeyKey(actorId: string, idempotencyKey: string): string {
  return `${actorId}\u0000${idempotencyKey}`;
}

function clonePublicRecord(record: StoredPatternMigration): ArchitecturePatternMigrationPersistedRecord {
  return {
    targetArchitecture: structuredClone(record.targetArchitecture),
    targetRevision: structuredClone(record.targetRevision),
    lineage: structuredClone(record.lineage),
  };
}

function sanitizeMigrationAuditDetails(input: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeAuditDetails(input);
  return Object.fromEntries(
    Object.entries(sanitized).filter(([key]) => AUDIT_DETAIL_KEYS.has(key)),
  );
}
