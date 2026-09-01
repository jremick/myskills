/**
 * Metadata-only target observations, health records, and deterministic
 * adapter/capability/observation digests.
 */

import {
  canonicalizeJson,
  runtimeExposureModes,
  sha256Hex,
  type RuntimeExposureMode,
} from "./architecture.js";
import {
  architectureTargetConfigFindingSeverities,
  architectureTargetHealthStatuses,
  architectureTargetLimits,
  architectureTargetSchemaVersion,
  type ArchitectureTargetAdapterDescriptor,
  type ArchitectureTargetCapabilitySet,
  type ArchitectureTargetConfigFinding,
  type ArchitectureTargetHealth,
  type ArchitectureTargetObservedSkill,
  type ArchitectureTargetObservation,
  type ArchitectureTargetObservationInput,
  type ArchitectureTargetPromptAwareness,
  type ArchitectureTargetValidationIssue,
  type ArchitectureTargetValidationResult,
  ArchitectureTargetValidationError,
} from "./architecture-target-contracts.js";
import {
  checkSensitiveKeys,
  checkUnknownKeys,
  findingCodePattern,
  identifierPattern,
  isOneOf,
  isRecord,
  issue,
  normalizeCapabilities,
  validateAdapterDescriptor,
  validateCapabilities,
  validateMetadata,
  validDigest,
  validIdentifier,
  validIsoTimestamp,
  validText,
} from "./architecture-target-validation.js";

function descriptorForDigest(input: ArchitectureTargetAdapterDescriptor): ArchitectureTargetAdapterDescriptor {
  const result = validateAdapterDescriptor(input, "adapter", []);
  if (!result) throw new ArchitectureTargetValidationError([{ code: "ARCHITECTURE_TARGET_ADAPTER_INVALID", message: "Adapter descriptor is invalid." }]);
  return result;
}

/** Calculate the stable identity of an adapter implementation/contract. */
export function architectureTargetAdapterDigest(input: ArchitectureTargetAdapterDescriptor): string {
  return sha256Hex(canonicalizeJson(descriptorForDigest(input)));
}

/** Calculate the stable digest of a target capability projection. */
export function architectureTargetCapabilitiesDigest(input: ArchitectureTargetCapabilitySet): string {
  const errors: ArchitectureTargetValidationIssue[] = [];
  const normalized = validateCapabilities(input, "capabilities", errors);
  if (errors.length > 0 || !normalized) throw new ArchitectureTargetValidationError(errors.length > 0 ? errors : [{ code: "ARCHITECTURE_TARGET_CAPABILITIES_INVALID", message: "Capabilities are invalid." }]);
  return sha256Hex(canonicalizeJson(normalizeCapabilities(normalized)));
}

function validateObservedSkill(
  value: unknown,
  path: string,
  errors: ArchitectureTargetValidationIssue[],
): ArchitectureTargetObservedSkill | undefined {
  if (!isRecord(value)) {
    issue(errors, "ARCHITECTURE_TARGET_SKILL_INVALID", "Observed skill must be an object.", path);
    return undefined;
  }
  checkUnknownKeys(value, ["skillRefId", "slug", "version", "digest", "kind", "enabled", "runtimeExposure", "configurationDigest", "configured", "managed", "supported", "metadata"], path, errors);
  if (value.skillRefId !== undefined && !validIdentifier(value.skillRefId)) issue(errors, "ARCHITECTURE_TARGET_SKILL_INVALID", "Observed skill skillRefId must be a bounded identifier.", `${path}.skillRefId`);
  if (!validText(value.slug, architectureTargetLimits.identifierLength) || !identifierPattern.test(value.slug)) issue(errors, "ARCHITECTURE_TARGET_SKILL_INVALID", "Observed skill slug must be a bounded identifier.", `${path}.slug`);
  if (value.version !== undefined && !validText(value.version, architectureTargetLimits.versionLength)) issue(errors, "ARCHITECTURE_TARGET_SKILL_INVALID", "Observed skill version must be a bounded string.", `${path}.version`);
  if (value.digest !== undefined && !validDigest(value.digest)) issue(errors, "ARCHITECTURE_TARGET_SKILL_INVALID", "Observed skill digest must be a lowercase SHA-256 digest.", `${path}.digest`);
  if (value.kind !== undefined && value.kind !== "router" && value.kind !== "leaf") issue(errors, "ARCHITECTURE_TARGET_SKILL_INVALID", "Observed skill kind must be router or leaf.", `${path}.kind`);
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") issue(errors, "ARCHITECTURE_TARGET_SKILL_INVALID", "Observed skill enabled must be boolean.", `${path}.enabled`);
  if (value.runtimeExposure !== undefined && !isOneOf(value.runtimeExposure, runtimeExposureModes)) issue(errors, "ARCHITECTURE_TARGET_SKILL_INVALID", "Observed skill runtimeExposure is invalid.", `${path}.runtimeExposure`);
  if (value.configurationDigest !== undefined && !validDigest(value.configurationDigest)) issue(errors, "ARCHITECTURE_TARGET_SKILL_INVALID", "Observed skill configurationDigest must be a lowercase SHA-256 digest.", `${path}.configurationDigest`);
  for (const key of ["configured", "managed", "supported"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") issue(errors, "ARCHITECTURE_TARGET_SKILL_INVALID", `Observed skill ${key} must be boolean.`, `${path}.${key}`);
  }
  const metadata = validateMetadata(value.metadata, `${path}.metadata`, errors);
  if (errors.some((error) => error.path?.startsWith(path))) return undefined;
  return {
    ...(value.skillRefId === undefined ? {} : { skillRefId: value.skillRefId as string }),
    slug: value.slug as string,
    ...(value.version === undefined ? {} : { version: value.version as string }),
    ...(value.digest === undefined ? {} : { digest: value.digest as string }),
    ...(value.kind === undefined ? {} : { kind: value.kind as "router" | "leaf" }),
    ...(value.enabled === undefined ? {} : { enabled: value.enabled as boolean }),
    ...(value.runtimeExposure === undefined ? {} : { runtimeExposure: value.runtimeExposure as RuntimeExposureMode }),
    ...(value.configurationDigest === undefined ? {} : { configurationDigest: value.configurationDigest as string }),
    ...(value.configured === undefined ? {} : { configured: value.configured as boolean }),
    ...(value.managed === undefined ? {} : { managed: value.managed as boolean }),
    ...(value.supported === undefined ? {} : { supported: value.supported as boolean }),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function validateConfigFinding(
  value: unknown,
  path: string,
  errors: ArchitectureTargetValidationIssue[],
): ArchitectureTargetConfigFinding | undefined {
  if (!isRecord(value)) {
    issue(errors, "ARCHITECTURE_TARGET_CONFIG_FINDING_INVALID", "Configuration finding must be an object.", path);
    return undefined;
  }
  checkUnknownKeys(value, ["code", "severity", "count"], path, errors);
  if (typeof value.code !== "string" || !findingCodePattern.test(value.code)) issue(errors, "ARCHITECTURE_TARGET_CONFIG_FINDING_INVALID", "Configuration finding code must be a bounded identifier.", `${path}.code`);
  if (!isOneOf(value.severity, architectureTargetConfigFindingSeverities)) issue(errors, "ARCHITECTURE_TARGET_CONFIG_FINDING_INVALID", "Configuration finding severity is invalid.", `${path}.severity`);
  if (typeof value.count !== "number" || !Number.isInteger(value.count) || value.count < 0 || value.count > architectureTargetLimits.counterMaximum) issue(errors, "ARCHITECTURE_TARGET_CONFIG_FINDING_INVALID", "Configuration finding count must be a bounded non-negative integer.", `${path}.count`);
  if (typeof value.code !== "string" || !findingCodePattern.test(value.code) || !isOneOf(value.severity, architectureTargetConfigFindingSeverities) || typeof value.count !== "number" || !Number.isInteger(value.count) || value.count < 0) return undefined;
  return { code: value.code, severity: value.severity, count: value.count };
}

function validatePromptAwareness(
  value: unknown,
  path: string,
  errors: ArchitectureTargetValidationIssue[],
): ArchitectureTargetPromptAwareness | undefined {
  if (!isRecord(value)) {
    issue(errors, "ARCHITECTURE_TARGET_PROMPT_AWARENESS_INVALID", "Prompt awareness must be an object.", path);
    return undefined;
  }
  checkUnknownKeys(value, ["detected", "count", "redacted"], path, errors);
  if (typeof value.detected !== "boolean") issue(errors, "ARCHITECTURE_TARGET_PROMPT_AWARENESS_INVALID", "Prompt awareness detected must be boolean.", `${path}.detected`);
  if (typeof value.count !== "number" || !Number.isInteger(value.count) || value.count < 0 || value.count > architectureTargetLimits.counterMaximum) issue(errors, "ARCHITECTURE_TARGET_PROMPT_AWARENESS_INVALID", "Prompt awareness count must be a bounded non-negative integer.", `${path}.count`);
  if (value.redacted !== undefined && typeof value.redacted !== "boolean") issue(errors, "ARCHITECTURE_TARGET_PROMPT_AWARENESS_INVALID", "Prompt awareness redacted must be boolean.", `${path}.redacted`);
  if (typeof value.detected !== "boolean" || typeof value.count !== "number" || !Number.isInteger(value.count) || value.count < 0 || (value.redacted !== undefined && typeof value.redacted !== "boolean")) return undefined;
  return {
    detected: value.detected,
    count: value.count,
    ...(value.redacted === undefined ? {} : { redacted: value.redacted }),
  };
}

function normalizeObservationCore(input: ArchitectureTargetObservationInput, errors: ArchitectureTargetValidationIssue[]): Omit<ArchitectureTargetObservation, "observedDigest"> | undefined {
  if (!isRecord(input)) {
    issue(errors, "ARCHITECTURE_TARGET_OBSERVATION_INVALID", "Architecture target observation must be an object.");
    return undefined;
  }
  checkUnknownKeys(input, ["schemaVersion", "id", "targetId", "targetGeneration", "adapterDigest", "capabilitiesDigest", "observedAt", "skills", "configFindings", "promptAwareness", "metadata", "observedDigest"], "observation", errors);
  if (input.schemaVersion !== architectureTargetSchemaVersion) issue(errors, "ARCHITECTURE_TARGET_SCHEMA_VERSION_INVALID", "Only target observation schema version 1 is supported.", "observation.schemaVersion");
  if (input.id !== undefined && !validIdentifier(input.id, architectureTargetLimits.observationIdLength)) issue(errors, "ARCHITECTURE_TARGET_OBSERVATION_INVALID", "Observation id must be a bounded identifier.", "observation.id");
  if (!validIdentifier(input.targetId)) issue(errors, "ARCHITECTURE_TARGET_OBSERVATION_INVALID", "Observation targetId must be a bounded identifier.", "observation.targetId");
  if (typeof input.targetGeneration !== "number" || !Number.isInteger(input.targetGeneration) || input.targetGeneration < 1 || input.targetGeneration > architectureTargetLimits.generationMaximum) issue(errors, "ARCHITECTURE_TARGET_OBSERVATION_INVALID", "Observation targetGeneration must be a positive bounded integer.", "observation.targetGeneration");
  if (!validDigest(input.adapterDigest)) issue(errors, "ARCHITECTURE_TARGET_OBSERVATION_INVALID", "Observation adapterDigest must be a lowercase SHA-256 digest.", "observation.adapterDigest");
  if (!validDigest(input.capabilitiesDigest)) issue(errors, "ARCHITECTURE_TARGET_OBSERVATION_INVALID", "Observation capabilitiesDigest must be a lowercase SHA-256 digest.", "observation.capabilitiesDigest");
  if (!validIsoTimestamp(input.observedAt)) issue(errors, "ARCHITECTURE_TARGET_OBSERVATION_INVALID", "Observation observedAt must be an ISO-8601 UTC timestamp.", "observation.observedAt");

  const rawSkills = input.skills;
  if (!Array.isArray(rawSkills)) issue(errors, "ARCHITECTURE_TARGET_OBSERVATION_INVALID", "Observation skills must be an array.", "observation.skills");
  if (Array.isArray(rawSkills) && rawSkills.length > architectureTargetLimits.skills) issue(errors, "ARCHITECTURE_TARGET_LIMIT_EXCEEDED", `Observation skills may contain at most ${architectureTargetLimits.skills} items.`, "observation.skills");
  const skills: ArchitectureTargetObservedSkill[] = [];
  for (const [index, item] of (Array.isArray(rawSkills) ? rawSkills : []).entries()) {
    const skill = validateObservedSkill(item, `observation.skills[${index}]`, errors);
    if (skill) skills.push(skill);
  }

  const rawFindings = input.configFindings;
  if (!Array.isArray(rawFindings)) issue(errors, "ARCHITECTURE_TARGET_OBSERVATION_INVALID", "Observation configFindings must be an array.", "observation.configFindings");
  if (Array.isArray(rawFindings) && rawFindings.length > architectureTargetLimits.configFindings) issue(errors, "ARCHITECTURE_TARGET_LIMIT_EXCEEDED", `Observation configFindings may contain at most ${architectureTargetLimits.configFindings} items.`, "observation.configFindings");
  const configFindings: ArchitectureTargetConfigFinding[] = [];
  for (const [index, item] of (Array.isArray(rawFindings) ? rawFindings : []).entries()) {
    const finding = validateConfigFinding(item, `observation.configFindings[${index}]`, errors);
    if (finding) configFindings.push(finding);
  }

  const promptAwareness = validatePromptAwareness(input.promptAwareness, "observation.promptAwareness", errors);
  const metadata = validateMetadata(input.metadata, "observation.metadata", errors);
  if (input.observedDigest !== undefined && !validDigest(input.observedDigest)) issue(errors, "ARCHITECTURE_TARGET_OBSERVATION_DIGEST_INVALID", "Observation observedDigest must be a lowercase SHA-256 digest.", "observation.observedDigest");
  if (
    errors.length > 0
    || input.schemaVersion !== 1
    || !validIdentifier(input.targetId)
    || typeof input.targetGeneration !== "number"
    || !Number.isInteger(input.targetGeneration)
    || !validDigest(input.adapterDigest)
    || !validDigest(input.capabilitiesDigest)
    || !validIsoTimestamp(input.observedAt)
    || !Array.isArray(rawSkills)
    || !Array.isArray(rawFindings)
    || !promptAwareness
  ) return undefined;
  return {
    schemaVersion: 1,
    ...(input.id === undefined ? {} : { id: input.id }),
    targetId: input.targetId,
    targetGeneration: input.targetGeneration,
    adapterDigest: input.adapterDigest,
    capabilitiesDigest: input.capabilitiesDigest,
    observedAt: input.observedAt,
    skills: skills.sort((left, right) => {
      const leftKey = canonicalizeJson(left);
      const rightKey = canonicalizeJson(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
    configFindings: configFindings.sort((left, right) => `${left.code}\u0000${left.severity}\u0000${left.count}`.localeCompare(`${right.code}\u0000${right.severity}\u0000${right.count}`)),
    promptAwareness,
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

/** Calculate an observation digest after strict metadata-only validation. */
export function architectureTargetObservationDigest(input: ArchitectureTargetObservationInput): string {
  const errors: ArchitectureTargetValidationIssue[] = [];
  const normalized = normalizeObservationCore(input, errors);
  if (errors.length > 0 || !normalized) throw new ArchitectureTargetValidationError(errors.length > 0 ? errors : [{ code: "ARCHITECTURE_TARGET_OBSERVATION_INVALID", message: "Observation is invalid." }]);
  return sha256Hex(canonicalizeJson(observationDigestProjection(normalized)));
}

/** Validate, normalize, and calculate the immutable observation digest. */
export function validateArchitectureTargetObservation(input: unknown): ArchitectureTargetValidationResult<ArchitectureTargetObservation> {
  const errors: ArchitectureTargetValidationIssue[] = [];
  if (!isRecord(input)) return { valid: false, errors: [{ code: "ARCHITECTURE_TARGET_OBSERVATION_INVALID", message: "Architecture target observation must be an object." }] };
  checkSensitiveKeys(input, "observation", errors);
  const normalized = normalizeObservationCore(input as ArchitectureTargetObservationInput, errors);
  if (!normalized) return { valid: false, errors };
  const observedDigest = sha256Hex(canonicalizeJson(observationDigestProjection(normalized)));
  if (input.observedDigest !== undefined && input.observedDigest !== observedDigest) issue(errors, "ARCHITECTURE_TARGET_OBSERVATION_DIGEST_MISMATCH", "Observation observedDigest does not match the normalized metadata record.", "observation.observedDigest");
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { ...normalized, observedDigest } };
}

export function assertValidArchitectureTargetObservation(input: unknown): ArchitectureTargetObservation {
  const result = validateArchitectureTargetObservation(input);
  if (!result.valid) throw new ArchitectureTargetValidationError(result.errors);
  return result.value;
}

export function validateArchitectureTargetHealth(input: unknown): ArchitectureTargetValidationResult<ArchitectureTargetHealth> {
  const errors: ArchitectureTargetValidationIssue[] = [];
  if (!isRecord(input)) return { valid: false, errors: [{ code: "ARCHITECTURE_TARGET_HEALTH_INVALID", message: "Architecture target health must be an object." }] };
  checkSensitiveKeys(input, "health", errors);
  checkUnknownKeys(input, ["status", "checkedAt", "metadata"], "health", errors);
  if (!isOneOf(input.status, architectureTargetHealthStatuses)) issue(errors, "ARCHITECTURE_TARGET_HEALTH_STATUS_INVALID", "Target health status is invalid.", "health.status");
  if (!validIsoTimestamp(input.checkedAt)) issue(errors, "ARCHITECTURE_TARGET_HEALTH_INVALID", "Target health checkedAt must be an ISO-8601 UTC timestamp.", "health.checkedAt");
  const metadata = validateMetadata(input.metadata, "health.metadata", errors);
  if (errors.length > 0 || !isOneOf(input.status, architectureTargetHealthStatuses) || !validIsoTimestamp(input.checkedAt)) return { valid: false, errors };
  return {
    valid: true,
    value: {
      status: input.status,
      checkedAt: input.checkedAt,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
  };
}

export const validateArchitectureTargetObservationRecord = validateArchitectureTargetObservation;
export const architectureObservationDigest = architectureTargetObservationDigest;

/**
 * Observation ids are storage identities. They may be assigned by the
 * server, so they must not change the content digest produced by an adapter.
 */
function observationDigestProjection(
  input: Omit<ArchitectureTargetObservation, "observedDigest">,
): Omit<ArchitectureTargetObservation, "id" | "observedDigest"> {
  const { id: _id, ...projection } = input;
  return projection;
}
