import { eq, sql } from "drizzle-orm";
import {
  AppError,
  architectureDigest,
  architecturePatternMigrationDiffDigest,
  architecturePatternMigrationDigest,
  assertValidArchitectureSpec,
  canonicalizeJson,
  type ArchitecturePatternMigrationDiff,
  type ArchitecturePatternMigrationMapping,
  type ArchitecturePatternMigrationResult,
} from "@myskills-app/core";
import type { Database } from "../db/client.js";
import {
  skillArchitecturePatternMigrations,
  skillArchitectureRevisions,
  skillArchitectures,
} from "../db/schema.js";
import type {
  ArchitecturePatternMigrationLineage,
  ArchitecturePatternMigrationPersistedRecord,
} from "./pattern-migration-service.js";
import type { ArchitectureOwnerReference, ArchitectureRecord, ArchitectureRevisionRecord } from "./types.js";

export type DbLike = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export type PatternMigrationRow = {
  lineage: typeof skillArchitecturePatternMigrations.$inferSelect;
  targetArchitecture: typeof skillArchitectures.$inferSelect;
  targetRevision: typeof skillArchitectureRevisions.$inferSelect;
};

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_MAPPING_BYTES = 32_768;
const MAX_DIFF_BYTES = 32_768;

/** Convert an immutable SQL migration row into the API-safe persisted record. */
export async function toPersistedRecord(
  db: DbLike,
  row: PatternMigrationRow,
): Promise<ArchitecturePatternMigrationPersistedRecord> {
  const owner = ownerFromDb(row.targetArchitecture.ownerUserId, row.targetArchitecture.ownerTeamId);
  if (!owner) throw persistedInvalid();
  const targetSpec = parseArchitectureSpec(row.targetRevision.spec, row.targetArchitecture.id, row.targetArchitecture.patternId);
  const revisionCountRow = await db
    .select({ count: sql<number>`count(*)` })
    .from(skillArchitectureRevisions)
    .where(eq(skillArchitectureRevisions.architectureId, row.targetArchitecture.id));
  const revisionCount = Number(revisionCountRow[0]?.count ?? 0);
  const access = ownerAccess(owner, Number(row.targetArchitecture.accessPolicyVersion));
  const targetArchitecture: ArchitectureRecord = {
    id: row.targetArchitecture.id,
    ownerUserId: row.targetArchitecture.ownerUserId,
    ownerTeamId: row.targetArchitecture.ownerTeamId,
    owner,
    ownerType: owner.type,
    ownerId: owner.id,
    accessPolicyVersion: Number(row.targetArchitecture.accessPolicyVersion),
    access,
    name: row.targetArchitecture.name,
    description: row.targetArchitecture.description,
    patternId: row.targetArchitecture.patternId as ArchitectureRecord["patternId"],
    currentRevisionId: row.targetArchitecture.currentRevisionId,
    revisionCount,
    createdAt: row.targetArchitecture.createdAt.toISOString(),
    updatedAt: row.targetArchitecture.updatedAt.toISOString(),
  };
  const targetRevision: ArchitectureRevisionRecord = {
    id: row.targetRevision.id,
    architectureId: row.targetRevision.architectureId,
    revisionNumber: row.targetRevision.revisionNumber,
    message: row.targetRevision.message,
    spec: targetSpec,
    createdByUserId: row.targetRevision.createdByUserId,
    createdAt: row.targetRevision.createdAt.toISOString(),
    access,
  };
  const lineage = lineageFromDb(row.lineage);
  validatePersistedRecord(targetArchitecture, targetRevision, lineage);
  return { targetArchitecture, targetRevision, lineage };
}

export function validatePersistedRecord(
  targetArchitecture: ArchitectureRecord,
  targetRevision: ArchitectureRevisionRecord,
  lineage: ArchitecturePatternMigrationLineage,
): void {
  if (targetArchitecture.id !== lineage.targetArchitectureId
    || targetRevision.id !== lineage.targetRevisionId
    || targetRevision.architectureId !== targetArchitecture.id
    || targetRevision.spec.id !== targetArchitecture.id
    || targetRevision.spec.pattern.id !== lineage.targetPatternId
    || architectureDigest(targetRevision.spec) !== lineage.targetRevisionDigest) {
    throw persistedInvalid();
  }
  validateMapping(lineage.mapping);
  validateDiff(lineage.diff);
  if (architecturePatternMigrationDiffDigest(lineage.diff) !== lineage.diffDigest) throw persistedInvalid();
  if (architecturePatternMigrationDigest(migrationValue(lineage, targetRevision.spec)) !== lineage.migrationDigest) {
    throw persistedInvalid();
  }
}

export function parseArchitectureSpec(value: unknown, expectedId: string, expectedPatternId: string) {
  try {
    const spec = assertValidArchitectureSpec(value);
    if (spec.id !== expectedId || spec.pattern.id !== expectedPatternId) throw new Error("identity");
    return spec;
  } catch {
    throw new AppError("Persisted architecture revision is invalid.", "PERSISTED_ARCHITECTURE_INVALID", 500);
  }
}

export function lineageFromDb(row: typeof skillArchitecturePatternMigrations.$inferSelect): ArchitecturePatternMigrationLineage {
  return {
    id: row.id,
    schemaVersion: row.schemaVersion as 1,
    mode: row.mode as "derive-shell",
    sourceArchitectureId: row.sourceArchitectureId,
    sourceRevisionId: row.sourceRevisionId,
    sourcePatternId: row.sourcePatternId as ArchitecturePatternMigrationLineage["sourcePatternId"],
    sourceRevisionDigest: row.sourceRevisionDigest,
    targetArchitectureId: row.targetArchitectureId,
    targetRevisionId: row.targetRevisionId,
    targetPatternId: row.targetPatternId as ArchitecturePatternMigrationLineage["targetPatternId"],
    targetRevisionDigest: row.targetRevisionDigest,
    mappingStatus: row.mappingStatus as ArchitecturePatternMigrationLineage["mappingStatus"],
    mapping: row.mapping as ArchitecturePatternMigrationMapping,
    diff: row.diff as ArchitecturePatternMigrationDiff,
    migrationDigest: row.migrationDigest,
    diffDigest: row.diffDigest,
    actorUserId: row.actorUserId,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
  };
}

export function migrationValue(
  lineage: ArchitecturePatternMigrationLineage,
  targetSpec: ReturnType<typeof assertValidArchitectureSpec>,
): ArchitecturePatternMigrationResult {
  return {
    schemaVersion: 1,
    mode: "derive-shell",
    source: {
      architectureId: lineage.sourceArchitectureId,
      patternId: lineage.sourcePatternId,
      revisionDigest: lineage.sourceRevisionDigest,
    },
    target: {
      patternId: lineage.targetPatternId,
      spec: targetSpec,
      revisionDigest: lineage.targetRevisionDigest,
    },
    mappingStatus: lineage.mappingStatus,
    diff: lineage.diff,
    issues: [],
    migrationDigest: "",
    diffDigest: lineage.diffDigest,
  };
}

export function assertRecordOwnerMetadata(record: ArchitectureRecord, field: string): void {
  const owner = ownerFromDb(record.ownerUserId, record.ownerTeamId);
  if (!owner || !sameOwner(owner, record.owner) || record.ownerType !== owner.type || record.ownerId !== owner.id
    || record.access.owner.type !== owner.type || record.access.owner.id !== owner.id) {
    throw new AppError(`${field} owner metadata is invalid.`, "ARCHITECTURE_PATTERN_MIGRATION_OWNER_INVALID", 409);
  }
}

export function sameOwner(left: ArchitectureOwnerReference, right: ArchitectureOwnerReference): boolean {
  return left.type === right.type && left.id === right.id;
}

export function ownerFromDb(ownerUserId: string | null, ownerTeamId: string | null): ArchitectureOwnerReference | null {
  if (ownerUserId && !ownerTeamId) return { type: "user", id: ownerUserId };
  if (ownerTeamId && !ownerUserId) return { type: "team", id: ownerTeamId };
  return null;
}

export function ownerAccess(owner: ArchitectureOwnerReference, accessPolicyVersion: number): ArchitectureRecord["access"] {
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

export function validateMapping(value: unknown): asserts value is ArchitecturePatternMigrationMapping {
  if (!isRecord(value)) throw new AppError("Pattern migration mapping is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_INVALID", 400);
  const keys = Object.keys(value).sort();
  const allowed = ["allowUnassignedLeafFallback", "rootLabel", "rootRouterId", "routerGroups"];
  if (keys.some((key) => !allowed.includes(key))) throw new AppError("Pattern migration mapping contains an unsupported field.", "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_UNKNOWN_FIELD", 400);
  if (value.rootRouterId !== undefined) validateIdentifier(value.rootRouterId, "mapping.rootRouterId");
  if (value.rootLabel !== undefined) validateSafeText(value.rootLabel, "mapping.rootLabel", 160, true);
  if (value.allowUnassignedLeafFallback !== undefined && typeof value.allowUnassignedLeafFallback !== "boolean") {
    throw new AppError("Pattern migration mapping fallback flag is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_INVALID", 400);
  }
  if (value.routerGroups !== undefined) {
    if (!Array.isArray(value.routerGroups) || value.routerGroups.length > 500) throw new AppError("Pattern migration mapping groups are invalid.", "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_INVALID", 400);
    const groupIds = new Set<string>();
    const leafIds = new Set<string>();
    for (const group of value.routerGroups) {
      if (!isRecord(group)) throw new AppError("Pattern migration mapping group is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_INVALID", 400);
      if (Object.keys(group).some((key) => !["id", "label", "parentRouterId", "leafNodeIds"].includes(key))) throw new AppError("Pattern migration mapping group contains an unsupported field.", "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_UNKNOWN_FIELD", 400);
      const id = validateIdentifier(group.id, "mapping.routerGroups.id");
      if (groupIds.has(id)) throw new AppError("Pattern migration mapping group ids must be unique.", "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_DUPLICATE", 400);
      groupIds.add(id);
      validateSafeText(group.label, "mapping.routerGroups.label", 160, true);
      if (group.parentRouterId !== undefined && group.parentRouterId !== null) validateIdentifier(group.parentRouterId, "mapping.routerGroups.parentRouterId");
      if (!Array.isArray(group.leafNodeIds) || group.leafNodeIds.length === 0 || group.leafNodeIds.length > 500) throw new AppError("Pattern migration mapping leaf ids are invalid.", "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_INVALID", 400);
      for (const leafId of group.leafNodeIds) {
        const idValue = validateIdentifier(leafId, "mapping.routerGroups.leafNodeIds");
        if (leafIds.has(idValue)) throw new AppError("Pattern migration mapping leaf ids must be unique.", "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_DUPLICATE", 400);
        leafIds.add(idValue);
      }
    }
  }
  if (canonicalizeJson(value).length > MAX_MAPPING_BYTES) throw new AppError("Pattern migration mapping is too large.", "ARCHITECTURE_PATTERN_MIGRATION_LIMIT_EXCEEDED", 413);
}

export function validateDiff(value: unknown): asserts value is ArchitecturePatternMigrationDiff {
  if (!isRecord(value)) throw new AppError("Pattern migration diff is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_LINEAGE_INVALID", 400);
  const allowed = ["addedEdgeCount", "addedRouterNodeIds", "droppedRouterNodeIds", "preservedLeafNodeIds", "preservedSkillRefIds", "removedEdgeCount", "rewrittenBindingCount"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new AppError("Pattern migration diff contains an unsupported field.", "ARCHITECTURE_PATTERN_MIGRATION_LINEAGE_INVALID", 400);
  for (const field of ["preservedSkillRefIds", "preservedLeafNodeIds", "addedRouterNodeIds", "droppedRouterNodeIds"] as const) {
    if (!Array.isArray(value[field]) || value[field].some((entry) => !isIdentifier(entry))) throw new AppError("Pattern migration diff identifiers are invalid.", "ARCHITECTURE_PATTERN_MIGRATION_LINEAGE_INVALID", 400);
  }
  for (const field of ["addedEdgeCount", "removedEdgeCount", "rewrittenBindingCount"] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) throw new AppError("Pattern migration diff counts are invalid.", "ARCHITECTURE_PATTERN_MIGRATION_LINEAGE_INVALID", 400);
  }
  if (canonicalizeJson(value).length > MAX_DIFF_BYTES) throw new AppError("Pattern migration diff is too large.", "ARCHITECTURE_PATTERN_MIGRATION_LIMIT_EXCEEDED", 413);
}

function persistedInvalid(): AppError {
  return new AppError("Persisted pattern migration is invalid.", "PERSISTED_ARCHITECTURE_PATTERN_MIGRATION_INVALID", 500);
}

function validateIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) throw new AppError(`${field} is invalid.`, "ARCHITECTURE_PATTERN_MIGRATION_IDENTIFIER_INVALID", 400);
  return value;
}

function validateSafeText(value: unknown, field: string, maxLength: number, required: boolean): string {
  if (typeof value !== "string") throw new AppError(`${field} is invalid.`, "ARCHITECTURE_PATTERN_MIGRATION_METADATA_INVALID", 400);
  const normalized = value.trim();
  if ((required && normalized.length === 0) || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized) || unsafeText(normalized)) {
    throw new AppError(`${field} is invalid.`, "ARCHITECTURE_PATTERN_MIGRATION_METADATA_INVALID", 400);
  }
  return normalized;
}

function unsafeText(value: string): boolean {
  return /(https?:\/\/|ftp:\/\/|file:\/\/|-----BEGIN [A-Z ]+-----|(^|[\s(])\/(Users|home|root|private|var|tmp|etc|opt|workspace)([\/\s)]|$)|(^|\s)(bearer|basic)\s+[A-Za-z0-9._~+\/-]{8,}|(api[_-]?key|authorization|credential|password|private[-_ ]?key|secret|token)\s*[:=])/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}
