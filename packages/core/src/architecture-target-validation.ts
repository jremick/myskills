/**
 * Strict target validation and shared metadata privacy guards.
 *
 * All target, adapter-context, and nested metadata validation reuses this
 * module so sensitive source and machine data remains denied consistently.
 */

import {
  architectureTargetAdapterContractVersions,
  architectureTargetCapabilityNames,
  architectureTargetConsentStatuses,
  architectureTargetLimits,
  architectureTargetMutationCapabilities,
  architectureTargetOwnerReferenceTypes,
  architectureTargetSchemaVersion,
  architectureTargetStatuses,
  type ArchitectureTarget,
  type ArchitectureTargetAdapterContext,
  type ArchitectureTargetAdapterDescriptor,
  type ArchitectureTargetCapability,
  type ArchitectureTargetCapabilitySet,
  type ArchitectureTargetConsent,
  type ArchitectureTargetConsentStatus,
  type ArchitectureTargetMetadata,
  type ArchitectureTargetMetadataValue,
  type ArchitectureTargetOwnerReference,
  type ArchitectureTargetValidationCode,
  type ArchitectureTargetValidationIssue,
  type ArchitectureTargetValidationResult,
  ArchitectureTargetValidationError,
} from "./architecture-target-contracts.js";

export const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const textPattern = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/;
const metadataKeyPattern = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
const unsafeMetadataValuePattern =
  /(?:\b(?:https?|ftp):\/\/|(?:^|[\s(])(?:\/\/|\\\\|~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\/(?:[A-Za-z0-9._-]+[\\/])|\/(?:Users|home|root|private|var|tmp|etc|opt|workspace|mnt|Volumes)(?:[\\/]|$))|(?:^|[\s(])(?:[A-Za-z0-9._-]+[\\/])+[A-Za-z0-9._-]+(?:$|[\s)])|(?:^|[\s(])(?:localhost|127\.0\.0\.1)(?::\d+)?(?:[\\/]|$)|-----BEGIN [A-Z0-9 ]+-----|\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]{8,}|\b(?:api[_ -]?key|auth(?:entication|orization)?|credential|password|private[-_ ]?key|secret|token)\b\s*[:=]\s*\S+|\b(?:secret|token|credential|password|private\s+key|api\s+key|authorization|authentication|prompt|content|body|package\s+bytes?)\b)/i;
const digestPattern = /^[a-f0-9]{64}$/;
const adapterKindPattern = /^[a-z][a-z0-9._-]{0,63}$/;
export const findingCodePattern = /^[a-z][a-z0-9._:-]{0,63}$/;
const sensitiveMetadataKeyPattern = /(?:^|[^a-z0-9])(?:api-key|authorization|credential|cookie|password|private-key|secret|token|prompt|path|endpoint|url|package|content|config|root|body|source|raw|snapshot|payload|file|filename|directory|home|host|machine)(?:$|[^a-z0-9])/i;
const safeKnownKeys = new Set([
  "schemaVersion",
  "id",
  "targetId",
  "targetGeneration",
  "name",
  "owner",
  "type",
  "adapter",
  "kind",
  "version",
  "contractVersion",
  "architectureId",
  "environmentId",
  "profileId",
  "status",
  "consent",
  "requestedAt",
  "grantedAt",
  "deniedAt",
  "revokedAt",
  "generation",
  "identityDigest",
  "capabilities",
  "inventory.read",
  "health.read",
  "plan.read",
  "apply",
  "rollback",
  "sync.write",
  "metadata",
  "skills",
  "skillRefId",
  "slug",
  "digest",
  "runtimeExposure",
  "configurationDigest",
  "configured",
  "managed",
  "supported",
  "configFindings",
  "code",
  "severity",
  "count",
  "promptAwareness",
  "detected",
  "redacted",
  "adapterDigest",
  "capabilitiesDigest",
  "observedAt",
  "observedDigest",
  "checkedAt",
  "createdAt",
  "updatedAt",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key)).sort();
}

export function issue(
  errors: ArchitectureTargetValidationIssue[],
  code: ArchitectureTargetValidationCode,
  message: string,
  path?: string,
): void {
  errors.push(path ? { code, message, path } : { code, message });
}

export function checkUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: ArchitectureTargetValidationIssue[],
): void {
  for (const key of unknownKeys(value, allowed)) {
    issue(errors, "ARCHITECTURE_TARGET_UNKNOWN_FIELD", `Field '${key}' is not accepted.`, `${path}.${key}`);
  }
}

/** Detect denied names at every object depth, including nested metadata. */
export function checkSensitiveKeys(value: unknown, path: string, errors: ArchitectureTargetValidationIssue[]): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) checkSensitiveKeys(item, `${path}[${index}]`, errors);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveMetadataKey(key) && !safeKnownKeys.has(key)) {
      issue(errors, "ARCHITECTURE_TARGET_SENSITIVE_FIELD", `Field '${key}' is not permitted in metadata-only target records.`, `${path}.${key}`);
    }
    checkSensitiveKeys(item, `${path}.${key}`, errors);
  }
}

export function validIdentifier(value: unknown, maximum = architectureTargetLimits.identifierLength): value is string {
  return typeof value === "string" && value.length <= maximum && identifierPattern.test(value);
}

export function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && textPattern.test(value);
}

export function validDigest(value: unknown): value is string {
  return typeof value === "string" && digestPattern.test(value);
}

export function validIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64 || !textPattern.test(value)) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

export function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function normalizeMetadata(value: ArchitectureTargetMetadata): ArchitectureTargetMetadata {
  const normalized: ArchitectureTargetMetadata = {};
  for (const key of Object.keys(value).sort()) normalized[key] = value[key];
  return normalized;
}

export function validateMetadata(
  value: unknown,
  path: string,
  errors: ArchitectureTargetValidationIssue[],
): ArchitectureTargetMetadata | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issue(errors, "ARCHITECTURE_TARGET_METADATA_INVALID", "Metadata must be a bounded object of scalar values.", path);
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length > architectureTargetLimits.metadataKeys) {
    issue(errors, "ARCHITECTURE_TARGET_LIMIT_EXCEEDED", `Metadata may contain at most ${architectureTargetLimits.metadataKeys} fields.`, path);
  }
  const normalized: ArchitectureTargetMetadata = {};
  for (const [key, item] of entries) {
    if (key.length === 0 || key.length > architectureTargetLimits.metadataKeyLength || isSensitiveMetadataKey(key)) {
      issue(errors, "ARCHITECTURE_TARGET_SENSITIVE_FIELD", `Metadata field '${key}' is not allowed.`, `${path}.${key}`);
    }
    if (!metadataKeyPattern.test(key)) {
      issue(errors, "ARCHITECTURE_TARGET_METADATA_INVALID", `Metadata field '${key}' must use a safe identifier shape.`, `${path}.${key}`);
    }
    if (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      issue(errors, "ARCHITECTURE_TARGET_METADATA_INVALID", "Metadata values must be scalar.", `${path}.${key}`);
      continue;
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      issue(errors, "ARCHITECTURE_TARGET_METADATA_INVALID", "Metadata numbers must be finite.", `${path}.${key}`);
      continue;
    }
    if (typeof item === "string") {
      if (item.length > architectureTargetLimits.metadataStringLength) {
        issue(errors, "ARCHITECTURE_TARGET_LIMIT_EXCEEDED", `Metadata strings must contain at most ${architectureTargetLimits.metadataStringLength} printable characters.`, `${path}.${key}`);
        continue;
      }
      if (!textPattern.test(item) || unsafeMetadataValuePattern.test(item)) {
        issue(errors, "ARCHITECTURE_TARGET_SENSITIVE_FIELD", `Metadata value '${key}' contains unsafe or private content.`, `${path}.${key}`);
        continue;
      }
    }
    normalized[key] = item as ArchitectureTargetMetadataValue;
  }
  return normalizeMetadata(normalized);
}

export function isSensitiveMetadataKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
  return sensitiveMetadataKeyPattern.test(normalized);
}

export function validateOwner(
  value: unknown,
  path: string,
  errors: ArchitectureTargetValidationIssue[],
): ArchitectureTargetOwnerReference | undefined {
  if (!isRecord(value)) {
    issue(errors, "ARCHITECTURE_TARGET_OWNER_INVALID", "Target owner must be an object.", path);
    return undefined;
  }
  checkUnknownKeys(value, ["type", "id"], path, errors);
  if (!isOneOf(value.type, architectureTargetOwnerReferenceTypes)) {
    issue(errors, "ARCHITECTURE_TARGET_OWNER_TYPE_INVALID", "Target owner type must be user, team, or organization.", `${path}.type`);
  }
  if (!validIdentifier(value.id)) issue(errors, "ARCHITECTURE_TARGET_OWNER_ID_INVALID", "Target owner id must be a bounded identifier.", `${path}.id`);
  if (!isOneOf(value.type, architectureTargetOwnerReferenceTypes) || !validIdentifier(value.id)) return undefined;
  return { type: value.type, id: value.id };
}

export function validateAdapterDescriptor(
  value: unknown,
  path: string,
  errors: ArchitectureTargetValidationIssue[],
): ArchitectureTargetAdapterDescriptor | undefined {
  if (!isRecord(value)) {
    issue(errors, "ARCHITECTURE_TARGET_ADAPTER_INVALID", "Target adapter descriptor must be an object.", path);
    return undefined;
  }
  checkUnknownKeys(value, ["kind", "version", "contractVersion"], path, errors);
  if (typeof value.kind !== "string" || !adapterKindPattern.test(value.kind)) {
    issue(errors, "ARCHITECTURE_TARGET_ADAPTER_KIND_INVALID", "Adapter kind must be a lowercase bounded identifier.", `${path}.kind`);
  }
  if (!validText(value.version, architectureTargetLimits.adapterVersionLength)) {
    issue(errors, "ARCHITECTURE_TARGET_ADAPTER_VERSION_INVALID", "Adapter version must be a bounded string.", `${path}.version`);
  }
  if (value.contractVersion !== architectureTargetAdapterContractVersions[0]) {
    issue(errors, "ARCHITECTURE_TARGET_ADAPTER_CONTRACT_VERSION_INVALID", "Only adapter contract version 1 is supported.", `${path}.contractVersion`);
  }
  if (typeof value.kind !== "string" || !adapterKindPattern.test(value.kind) || !validText(value.version, architectureTargetLimits.adapterVersionLength) || value.contractVersion !== 1) return undefined;
  return { kind: value.kind, version: value.version, contractVersion: 1 };
}

export function validateCapabilities(
  value: unknown,
  path: string,
  errors: ArchitectureTargetValidationIssue[],
): ArchitectureTargetCapabilitySet | undefined {
  if (!isRecord(value)) {
    issue(errors, "ARCHITECTURE_TARGET_CAPABILITIES_INVALID", "Target capabilities must be an object.", path);
    return undefined;
  }
  checkUnknownKeys(value, architectureTargetCapabilityNames, path, errors);
  const normalized: ArchitectureTargetCapabilitySet = {};
  const knownNames = new Set<string>(architectureTargetCapabilityNames);
  for (const [key, item] of Object.entries(value)) {
    if (!knownNames.has(key)) continue;
    if (typeof item !== "boolean") {
      issue(errors, "ARCHITECTURE_TARGET_CAPABILITY_INVALID", "Capability values must be boolean.", `${path}.${key}`);
      continue;
    }
    if ((architectureTargetMutationCapabilities as readonly string[]).includes(key) && item === true) {
      issue(errors, "ARCHITECTURE_TARGET_MUTATION_CAPABILITY_ENABLED", "Mutation capabilities must be absent or explicitly false in contract version 1.", `${path}.${key}`);
      continue;
    }
    normalized[key as ArchitectureTargetCapability] = item;
  }
  return normalized;
}

export function validateConsent(
  value: unknown,
  path: string,
  errors: ArchitectureTargetValidationIssue[],
): ArchitectureTargetConsent | undefined {
  if (!isRecord(value)) {
    issue(errors, "ARCHITECTURE_TARGET_CONSENT_INVALID", "Target consent must be an object.", path);
    return undefined;
  }
  checkUnknownKeys(value, ["status", "requestedAt", "grantedAt", "deniedAt", "revokedAt"], path, errors);
  if (!isOneOf(value.status, architectureTargetConsentStatuses)) issue(errors, "ARCHITECTURE_TARGET_CONSENT_STATUS_INVALID", "Target consent status is invalid.", `${path}.status`);
  if (!validIsoTimestamp(value.requestedAt)) issue(errors, "ARCHITECTURE_TARGET_CONSENT_TIMESTAMP_REQUIRED", "Consent requestedAt must be an ISO-8601 UTC timestamp.", `${path}.requestedAt`);

  const timestamps = ["grantedAt", "deniedAt", "revokedAt"] as const;
  for (const timestamp of timestamps) {
    const item = value[timestamp];
    if (item !== undefined && item !== null && !validIsoTimestamp(item)) {
      issue(errors, "ARCHITECTURE_TARGET_TIMESTAMP_INVALID", `${timestamp} must be an ISO-8601 UTC timestamp or null.`, `${path}.${timestamp}`);
    }
  }
  const requiredTimestamp: Record<ArchitectureTargetConsentStatus, "grantedAt" | "deniedAt" | "revokedAt" | null> = {
    pending: null,
    granted: "grantedAt",
    denied: "deniedAt",
    revoked: "revokedAt",
  };
  const required = isOneOf(value.status, architectureTargetConsentStatuses) ? requiredTimestamp[value.status] : null;
  if (required && !validIsoTimestamp(value[required])) {
    issue(errors, "ARCHITECTURE_TARGET_CONSENT_TIMESTAMP_REQUIRED", `Consent ${required} is required for status '${value.status}'.`, `${path}.${required}`);
  }
  if (!isOneOf(value.status, architectureTargetConsentStatuses) || !validIsoTimestamp(value.requestedAt)) return undefined;
  return {
    status: value.status,
    requestedAt: value.requestedAt,
    ...(value.grantedAt === undefined ? {} : { grantedAt: value.grantedAt as string | null }),
    ...(value.deniedAt === undefined ? {} : { deniedAt: value.deniedAt as string | null }),
    ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt as string | null }),
  };
}

export function validateOptionalTimestamp(value: unknown, path: string, errors: ArchitectureTargetValidationIssue[]): string | undefined {
  if (value === undefined) return undefined;
  if (!validIsoTimestamp(value)) {
    issue(errors, "ARCHITECTURE_TARGET_TIMESTAMP_INVALID", "Timestamp must be an ISO-8601 UTC timestamp.", path);
    return undefined;
  }
  return value;
}

export function normalizeCapabilities(value: ArchitectureTargetCapabilitySet): ArchitectureTargetCapabilitySet {
  const normalized: ArchitectureTargetCapabilitySet = {};
  for (const key of Object.keys(value).sort()) normalized[key as ArchitectureTargetCapability] = value[key as ArchitectureTargetCapability];
  return normalized;
}

/** Validate and normalize a connected target registry record. */
export function validateArchitectureTarget(input: unknown): ArchitectureTargetValidationResult<ArchitectureTarget> {
  const errors: ArchitectureTargetValidationIssue[] = [];
  if (!isRecord(input)) return { valid: false, errors: [{ code: "ARCHITECTURE_TARGET_INVALID_OBJECT", message: "Architecture target must be an object." }] };
  checkSensitiveKeys(input, "target", errors);
  checkUnknownKeys(
    input,
    ["schemaVersion", "id", "name", "owner", "adapter", "architectureId", "environmentId", "profileId", "status", "consent", "generation", "identityDigest", "capabilities", "metadata", "createdAt", "updatedAt"],
    "target",
    errors,
  );
  if (input.schemaVersion !== architectureTargetSchemaVersion) issue(errors, "ARCHITECTURE_TARGET_SCHEMA_VERSION_INVALID", "Only target schema version 1 is supported.", "target.schemaVersion");
  if (!validIdentifier(input.id)) issue(errors, "ARCHITECTURE_TARGET_ID_INVALID", "Target id must be a bounded identifier.", "target.id");
  if (!validText(input.name, architectureTargetLimits.nameLength)) issue(errors, "ARCHITECTURE_TARGET_NAME_INVALID", "Target name must be a bounded string.", "target.name");
  const owner = validateOwner(input.owner, "target.owner", errors);
  const adapter = validateAdapterDescriptor(input.adapter, "target.adapter", errors);
  if (!validIdentifier(input.architectureId)) issue(errors, "ARCHITECTURE_TARGET_ARCHITECTURE_ID_INVALID", "Target architectureId must be a bounded identifier.", "target.architectureId");
  if (!validIdentifier(input.environmentId)) issue(errors, "ARCHITECTURE_TARGET_ENVIRONMENT_ID_INVALID", "Target environmentId must be a bounded identifier.", "target.environmentId");
  if (!validIdentifier(input.profileId)) issue(errors, "ARCHITECTURE_TARGET_PROFILE_ID_INVALID", "Target profileId must be a bounded identifier.", "target.profileId");
  if (!isOneOf(input.status, architectureTargetStatuses)) issue(errors, "ARCHITECTURE_TARGET_STATUS_INVALID", "Target status is invalid.", "target.status");
  const consent = validateConsent(input.consent, "target.consent", errors);
  if (consent && input.status === "connected" && consent.status !== "granted") {
    issue(errors, "ARCHITECTURE_TARGET_CONSENT_INVALID", "A connected target requires granted consent.", "target.consent.status");
  }
  if (consent && input.status === "revoked" && consent.status !== "revoked") {
    issue(errors, "ARCHITECTURE_TARGET_CONSENT_INVALID", "A revoked target requires revoked consent.", "target.consent.status");
  }
  if (consent && consent.status === "revoked" && input.status !== "revoked") {
    issue(errors, "ARCHITECTURE_TARGET_CONSENT_INVALID", "Revoked consent requires a revoked target.", "target.status");
  }
  if (typeof input.generation !== "number" || !Number.isInteger(input.generation) || input.generation < 1 || input.generation > architectureTargetLimits.generationMaximum) {
    issue(errors, "ARCHITECTURE_TARGET_GENERATION_INVALID", "Target generation must be a positive bounded integer.", "target.generation");
  }
  if (!validDigest(input.identityDigest)) issue(errors, "ARCHITECTURE_TARGET_IDENTITY_DIGEST_INVALID", "Target identityDigest must be a lowercase SHA-256 digest.", "target.identityDigest");
  const capabilities = validateCapabilities(input.capabilities, "target.capabilities", errors);
  const metadata = validateMetadata(input.metadata, "target.metadata", errors);
  const createdAt = validateOptionalTimestamp(input.createdAt, "target.createdAt", errors);
  const updatedAt = validateOptionalTimestamp(input.updatedAt, "target.updatedAt", errors);
  if (
    errors.length > 0
    || input.schemaVersion !== 1
    || !validIdentifier(input.id)
    || !validText(input.name, architectureTargetLimits.nameLength)
    || !owner
    || !adapter
    || !validIdentifier(input.architectureId)
    || !validIdentifier(input.environmentId)
    || !validIdentifier(input.profileId)
    || !isOneOf(input.status, architectureTargetStatuses)
    || !consent
    || typeof input.generation !== "number"
    || !Number.isInteger(input.generation)
    || !validDigest(input.identityDigest)
    || !capabilities
  ) return { valid: false, errors };
  const value: ArchitectureTarget = {
    schemaVersion: 1,
    id: input.id,
    name: input.name,
    owner,
    adapter,
    architectureId: input.architectureId,
    environmentId: input.environmentId,
    profileId: input.profileId,
    status: input.status,
    consent,
    generation: input.generation,
    identityDigest: input.identityDigest,
    capabilities: normalizeCapabilities(capabilities),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
  return { valid: true, value };
}

export function assertValidArchitectureTarget(input: unknown): ArchitectureTarget {
  const result = validateArchitectureTarget(input);
  if (!result.valid) throw new ArchitectureTargetValidationError(result.errors);
  return result.value;
}

/** Validate the metadata-only context supplied to a read-only adapter. */
export function validateArchitectureTargetAdapterContext(input: unknown): ArchitectureTargetValidationResult<ArchitectureTargetAdapterContext> {
  const errors: ArchitectureTargetValidationIssue[] = [];
  if (!isRecord(input)) return { valid: false, errors: [{ code: "ARCHITECTURE_TARGET_ADAPTER_CONFORMANCE_INVALID", message: "Adapter context must be an object." }] };
  checkSensitiveKeys(input, "adapterContext", errors);
  checkUnknownKeys(input, ["targetId", "targetGeneration", "architectureId", "environmentId", "profileId", "adapterDigest", "capabilitiesDigest"], "adapterContext", errors);
  if (!validIdentifier(input.targetId)) issue(errors, "ARCHITECTURE_TARGET_OBSERVATION_INVALID", "Adapter context targetId must be a bounded identifier.", "adapterContext.targetId");
  if (typeof input.targetGeneration !== "number" || !Number.isInteger(input.targetGeneration) || input.targetGeneration < 1 || input.targetGeneration > architectureTargetLimits.generationMaximum) issue(errors, "ARCHITECTURE_TARGET_GENERATION_INVALID", "Adapter context targetGeneration must be a positive bounded integer.", "adapterContext.targetGeneration");
  if (!validIdentifier(input.architectureId)) issue(errors, "ARCHITECTURE_TARGET_ARCHITECTURE_ID_INVALID", "Adapter context architectureId must be a bounded identifier.", "adapterContext.architectureId");
  if (!validIdentifier(input.environmentId)) issue(errors, "ARCHITECTURE_TARGET_ENVIRONMENT_ID_INVALID", "Adapter context environmentId must be a bounded identifier.", "adapterContext.environmentId");
  if (!validIdentifier(input.profileId)) issue(errors, "ARCHITECTURE_TARGET_PROFILE_ID_INVALID", "Adapter context profileId must be a bounded identifier.", "adapterContext.profileId");
  if (!validDigest(input.adapterDigest)) issue(errors, "ARCHITECTURE_TARGET_OBSERVATION_INVALID", "Adapter context adapterDigest must be a lowercase SHA-256 digest.", "adapterContext.adapterDigest");
  if (!validDigest(input.capabilitiesDigest)) issue(errors, "ARCHITECTURE_TARGET_OBSERVATION_INVALID", "Adapter context capabilitiesDigest must be a lowercase SHA-256 digest.", "adapterContext.capabilitiesDigest");
  if (errors.length > 0 || !validIdentifier(input.targetId) || typeof input.targetGeneration !== "number" || !Number.isInteger(input.targetGeneration) || !validIdentifier(input.architectureId) || !validIdentifier(input.environmentId) || !validIdentifier(input.profileId) || !validDigest(input.adapterDigest) || !validDigest(input.capabilitiesDigest)) return { valid: false, errors };
  return {
    valid: true,
    value: {
      targetId: input.targetId,
      targetGeneration: input.targetGeneration,
      architectureId: input.architectureId,
      environmentId: input.environmentId,
      profileId: input.profileId,
      adapterDigest: input.adapterDigest,
      capabilitiesDigest: input.capabilitiesDigest,
    },
  };
}

export function assertValidArchitectureTargetAdapterContext(input: unknown): ArchitectureTargetAdapterContext {
  const result = validateArchitectureTargetAdapterContext(input);
  if (!result.valid) throw new ArchitectureTargetValidationError(result.errors);
  return result.value;
}

// Descriptive alias retained for callers that use "connected environment"
// terminology at their boundary.
export const validateConnectedArchitectureTarget = validateArchitectureTarget;
