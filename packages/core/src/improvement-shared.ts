import { canonicalizeJson, sha256Hex } from "./architecture-canonical.js";
import { parseSemanticVersion } from "./skill-updates.js";

/** Raised by every improvement normalizer. The API maps it to a 400 response. */
export class ImprovementContractError extends Error {
  readonly code = "INVALID_IMPROVEMENT_REQUEST";
}

export const improvementIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
export const improvementSha256Pattern = /^[0-9a-f]{64}$/;
const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/;
const urlPattern = /[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const absolutePathPattern = /(^|[\s("'=])(\/[A-Za-z0-9._~-]|~\/|[A-Za-z]:[\\/]|\\\\)/;

export function improvementDigest(value: unknown): string {
  return sha256Hex(canonicalizeJson(value));
}

export function fail(message: string): never {
  throw new ImprovementContractError(message);
}

export function objectInput(value: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) fail(`${field} field is not accepted: ${unknown}`);
  return record;
}

export function schemaVersionOne(value: unknown, field: string): 1 {
  if (value !== 1) fail(`${field} schemaVersion must be 1.`);
  return 1;
}

export function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !improvementIdentifierPattern.test(value)) fail(`${field} is invalid.`);
  return value;
}

export function sha256Field(value: unknown, field: string): string {
  if (typeof value !== "string" || !improvementSha256Pattern.test(value)) fail(`${field} must be a lowercase SHA-256 digest.`);
  return value;
}

export function skillSlug(value: unknown, field: string): string {
  if (typeof value !== "string" || !slugPattern.test(value)) fail(`${field} must be a skill slug.`);
  return value;
}

export function skillVersion(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 64 || !parseSemanticVersion(value)) fail(`${field} must be a semantic version.`);
  return value;
}

/** Bounded human text. Rejects control characters, URLs, and absolute paths so private locations never enter shared records. */
export function safeText(value: unknown, field: string, maxLength: number, options: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== "string") fail(`${field} must be a string.`);
  const text = value.trim();
  if (!options.allowEmpty && text.length === 0) fail(`${field} is required.`);
  if (text.length > maxLength) fail(`${field} exceeds ${maxLength} characters.`);
  if (controlCharacterPattern.test(text)) fail(`${field} contains control characters.`);
  if (urlPattern.test(text)) fail(`${field} must not contain URLs.`);
  if (absolutePathPattern.test(text)) fail(`${field} must not contain absolute paths.`);
  return text;
}

export function enumValue<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail(`${field} is invalid.`);
  return value as T;
}

export function integerField(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) fail(`${field} must be an integer from ${min} to ${max}.`);
  return value;
}

export function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(`${field} must be boolean.`);
  return value;
}

export function arrayField(value: unknown, field: string, maxItems: number, options: { minItems?: number } = {}): unknown[] {
  if (!Array.isArray(value)) fail(`${field} must be an array.`);
  if (value.length > maxItems) fail(`${field} exceeds ${maxItems} entries.`);
  if (value.length < (options.minItems ?? 0)) fail(`${field} requires at least ${options.minItems} entries.`);
  return value;
}

export function uniqueEnumArray<T extends string>(value: unknown, field: string, values: readonly T[], maxItems: number, options: { minItems?: number; sort?: boolean } = {}): T[] {
  const items = arrayField(value, field, maxItems, options).map((item) => enumValue(item, field, values));
  const unique = [...new Set(items)];
  return options.sort === false ? unique : unique.sort();
}

export function uniqueIdentifierArray(value: unknown, field: string, maxItems: number, options: { minItems?: number } = {}): string[] {
  return [...new Set(arrayField(value, field, maxItems, options).map((item) => identifier(item, field)))].sort();
}

export function textArray(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  const items = arrayField(value, field, maxItems).map((item) => safeText(item, field, maxLength));
  return [...new Set(items)];
}

/** Flat string, finite number, or boolean parameters. Keys are identifiers; strings follow safeText rules. */
export function scalarRecord(value: unknown, field: string, maxKeys: number): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxKeys) fail(`${field} exceeds ${maxKeys} keys.`);
  const result: Record<string, string | number | boolean> = {};
  for (const [key, item] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    identifier(key, `${field} key`);
    if (typeof item === "string") result[key] = safeText(item, `${field}.${key}`, 200, { allowEmpty: true });
    else if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
    else if (typeof item === "boolean") result[key] = item;
    else fail(`${field}.${key} must be a string, finite number, or boolean.`);
  }
  return result;
}

export function isoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 40 || Number.isNaN(Date.parse(value))) fail(`${field} must be an ISO timestamp.`);
  return new Date(value).toISOString();
}
