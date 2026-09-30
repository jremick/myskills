export const MAX_OPERATOR_RECEIPT_BYTES = 64 * 1024;
export const OPERATOR_FRESHNESS_WINDOW_MS = 26 * 60 * 60 * 1000;
export const OPERATOR_IMAGE_NAMES = ["api", "web", "mcp", "ops", "minio", "postgres"] as const;
export type OperatorImageName = typeof OPERATOR_IMAGE_NAMES[number];
export type OperatorImageHealth = "healthy" | "unhealthy" | "unavailable" | "disabled" | "tool";
export type OperatorBackupState = "current" | "stale" | "missing" | "error" | "not-configured";

export interface OperatorStatusReceipt {
  schemaVersion: 1;
  kind: "myskills-operator-status";
  capturedAt: string;
  source: { commit: string; version: string };
  images: Record<OperatorImageName, { expectedRef: string; actualRef: string | null; health: OperatorImageHealth }>;
  backup: { state: OperatorBackupState; capturedAt: string | null; runId: string | null };
}

type ReceiptResult = { ok: true; receipt: OperatorStatusReceipt } | { ok: false; message: string };
const rejected = "Receipt rejected. Choose the sanitized JSON from ./myskills.sh status --json. Only the documented status fields are accepted; do not include configuration or credentials.";
const imageHealth = new Set<unknown>(["healthy", "unhealthy", "unavailable", "disabled", "tool"]);
const backupStates = new Set<unknown>(["current", "stale", "missing", "error", "not-configured"]);
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const imageRefPattern = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const runIdPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z_[a-f0-9]{16}$/;

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !timestampPattern.test(value)) return false;
  const normalized = value.length === 20 ? value.replace("Z", ".000Z") : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === normalized;
}

function imageRef(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512 || !imageRefPattern.test(value)) return false;
  const repository = value.slice(0, value.indexOf("@"));
  // Docker references are repository paths, not URLs. Reject schemes,
  // credentials, empty/traversal segments and ports outside the registry host.
  if (repository.includes("://") || repository.includes("//")) return false;
  const segments = repository.split("/");
  return segments.every((segment, index) => {
    if (segment === "." || segment === ".." || !segment) return false;
    if (segment.includes(":")) return index === 0 && segments.length > 1 && /^[a-z0-9][a-z0-9.-]*:[1-9]\d{0,4}$/.test(segment) && Number(segment.split(":")[1]) <= 65535;
    return /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(segment);
  });
}

function runId(value: unknown): value is string {
  if (typeof value !== "string" || !runIdPattern.test(value)) return false;
  return timestamp(`${value.slice(0, 13)}:${value.slice(14, 16)}:${value.slice(17, 24)}`);
}

export function parseOperatorReceipt(text: string): ReceiptResult {
  if (new TextEncoder().encode(text).byteLength > MAX_OPERATOR_RECEIPT_BYTES) return { ok: false, message: "Receipt rejected. Choose a JSON receipt of 64 KiB or less." };
  try {
    const value: unknown = JSON.parse(text);
    if (!exactObject(value, ["schemaVersion", "kind", "capturedAt", "source", "images", "backup"]) || value.schemaVersion !== 1 || value.kind !== "myskills-operator-status" || !timestamp(value.capturedAt)) return { ok: false, message: rejected };
    if (!exactObject(value.source, ["commit", "version"]) || typeof value.source.commit !== "string" || !/^[a-f0-9]{40}$/.test(value.source.commit) || typeof value.source.version !== "string" || value.source.version.length > 64 || !versionPattern.test(value.source.version)) return { ok: false, message: rejected };
    if (!exactObject(value.images, OPERATOR_IMAGE_NAMES)) return { ok: false, message: rejected };
    for (const name of OPERATOR_IMAGE_NAMES) {
      const image = value.images[name];
      if (!exactObject(image, ["expectedRef", "actualRef", "health"]) || !imageRef(image.expectedRef) || (image.actualRef !== null && !imageRef(image.actualRef)) || !imageHealth.has(image.health)) return { ok: false, message: rejected };
    }
    if (!exactObject(value.backup, ["state", "capturedAt", "runId"]) || !backupStates.has(value.backup.state) || (value.backup.capturedAt !== null && !timestamp(value.backup.capturedAt)) || (value.backup.runId !== null && !runId(value.backup.runId))) return { ok: false, message: rejected };
    if ((value.backup.state === "current" || value.backup.state === "stale") && (value.backup.capturedAt === null || value.backup.runId === null)) return { ok: false, message: rejected };
    return { ok: true, receipt: value as unknown as OperatorStatusReceipt };
  } catch {
    return { ok: false, message: rejected };
  }
}

export function snapshotAge(capturedAt: string, now: number): "recent" | "stale" | "future" {
  const age = now - Date.parse(capturedAt);
  return age < 0 ? "future" : age > OPERATOR_FRESHNESS_WINDOW_MS ? "stale" : "recent";
}
