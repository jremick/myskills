import {
  AppError,
  architectureSyncControlLimits,
  type ArchitectureSyncMetadata,
  type ArchitectureSyncMetadataValue,
} from "@myskills-app/core";

const METADATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
const UNSAFE_METADATA_KEY_PATTERN = /(?:api[_-]?key|authorization|bearer|certificate|ciphertext|cookie|credential|directory|endpoint|filesystem|header|host|password|path|private[-_ ]?key|prompt|package|secret|token|url|username|config|content|(?:^|[_-])file(?:name|path|system)?(?:$|[_-])|file(?:name|path|system))/i;
const UNSAFE_METADATA_VALUE_PATTERN = /(?:https?:\/\/|ftp:\/\/|file:\/\/|-----BEGIN [A-Z ]+-----|(?:^|[\s(])(?:[A-Za-z]:[\\/]|\/(?:Users|home|root|private|var|tmp|etc|opt|workspace))|(?:^|\s)(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{8,}|(?:api[_-]?key|authorization|credential|password|private[-_ ]?key|secret|token|url|config|content)\s*[:=]|\b(?:raw\s+)?(?:config|configuration|package\s+content)\b)/i;

/**
 * Keys used by the PostgreSQL projection to retain non-UUID public ids and
 * other journal fields. They are never caller-owned metadata. Keeping this
 * list beside the sanitizer lets the memory and PostgreSQL stores enforce the
 * same public boundary before either persistence path runs.
 */
export const architectureSyncReservedMetadataKeys = new Set([
  "syncPublicId",
  "syncPublicRunId",
  "syncPublicTargetId",
  "syncPublicArchitectureId",
  "syncPublicRevisionId",
  "syncIntentDigest",
  "syncCapabilities",
  "syncApprovalId",
  "syncApprovalActorId",
  "syncApprovalExpiresAt",
  "syncApprovalMetadata",
  "syncLeaseId",
  "syncLeaseRunId",
  "syncLeaseTargetId",
  "syncLeaseGeneration",
  "syncLeaseHolderId",
  "syncLeaseFence",
  "syncLeaseAcquiredAt",
  "syncLeaseExpiresAt",
  "syncFailureOccurredAt",
  "syncFailureStepId",
  "syncFailureMessage",
  "syncFailureMetadata",
  "syncReceiptOrdinal",
  "syncRecoverySourceState",
  "syncRecoveryCondition",
  "syncRecoveryDecision",
  "syncRecoveryNextRunState",
  "syncRecoveryStepSourceState",
  "syncRecoveryStepNextState",
  "syncAction",
  "syncCode",
  "syncRecordedAt",
  "syncDedupeKey",
  "syncMetadata",
  "syncPublicActorId",
]);

/** Reject attempts to forge persistence markers in a public sync record. */
export function assertNoReservedArchitectureSyncMetadata(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (architectureSyncReservedMetadataKeys.has(key)) throw new AppError("Sync metadata uses a reserved persistence field.", "ARCHITECTURE_SYNC_METADATA_INVALID", 400);
  }
}

/** Normalize metadata before it can enter any API-visible sync record. */
export function sanitizeArchitectureSyncMetadata(value: unknown): ArchitectureSyncMetadata | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw metadataError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw metadataError();
  const entries = Object.entries(value);
  if (entries.length > architectureSyncControlLimits.metadataKeys) throw metadataError();
  const normalized: ArchitectureSyncMetadata = {};
  for (const [key, item] of entries) {
    if (!METADATA_KEY_PATTERN.test(key) || UNSAFE_METADATA_KEY_PATTERN.test(key)) throw metadataError();
    if (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") throw metadataError();
    if (typeof item === "number" && !Number.isFinite(item)) throw metadataError();
    if (typeof item === "string" && (item.length < 1 || item.length > architectureSyncControlLimits.metadataStringLength || /[\u0000-\u001f\u007f]/.test(item) || UNSAFE_METADATA_VALUE_PATTERN.test(item))) throw metadataError();
    normalized[key] = item as ArchitectureSyncMetadataValue;
  }
  const ordered: ArchitectureSyncMetadata = {};
  for (const key of Object.keys(normalized).sort()) ordered[key] = normalized[key];
  return Object.keys(ordered).length > 0 ? ordered : undefined;
}

function metadataError(): AppError {
  return new AppError("Sync metadata is invalid.", "ARCHITECTURE_SYNC_METADATA_INVALID", 400);
}
