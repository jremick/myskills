import { createHash } from "node:crypto";
import { AppError } from "@myskills-app/core";

export interface ChronologicalPageQuery { limit?: number; cursor?: string }
export interface ChronologicalPosition { createdAt: string; id: string }
export interface ChronologicalStoreQuery { limit: number; before?: ChronologicalPosition }

export function parseChronologicalPageQuery(input: unknown): ChronologicalPageQuery {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (params.cursor !== undefined && typeof params.cursor !== "string") invalidCursor();
  const limit = params.limit === undefined ? undefined : typeof params.limit === "string" ? Number(params.limit) : NaN;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw new AppError("Page size must be between 1 and 100.", "INVALID_PAGE_SIZE", 400);
  }
  return { limit, cursor: params.cursor as string | undefined };
}

// Keep six fractional digits: Postgres timestamps can distinguish rows that a
// JavaScript Date would round to the same millisecond.
export function chronologicalKey(row: { id: string; createdAt: string | Date }): ChronologicalPosition {
  const value = row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt;
  return { id: row.id, createdAt: value.replace(/\.(\d{3})Z$/, (_match, fraction: string) => `.${fraction}000Z`) };
}

export function compareChronological(left: ChronologicalPosition, right: ChronologicalPosition): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
  return left.id === right.id ? 0 : left.id < right.id ? 1 : -1;
}

export function chronologicalPagePosition(query: ChronologicalPageQuery, scope: string, defaultLimit = 100) {
  const limit = query.limit ?? defaultLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError("Invalid page size.", "INVALID_PAGE_SIZE", 400);
  const fingerprint = createHash("sha256").update(scope).digest("hex");
  let before: ChronologicalPosition | undefined;
  if (query.cursor !== undefined) {
    try {
      if (!query.cursor || query.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
      const text = Buffer.from(query.cursor, "base64url").toString("utf8");
      if (Buffer.from(text).toString("base64url") !== query.cursor) throw new Error();
      const value = JSON.parse(text) as Record<string, unknown>;
      if (value.v !== 1 || value.scope !== fingerprint || typeof value.id !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value.id) || typeof value.createdAt !== "string"
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.createdAt)
        || new Date(value.createdAt).toISOString() !== value.createdAt.replace(/(\.\d{3})\d{3}Z$/, "$1Z")) throw new Error();
      before = { id: value.id, createdAt: value.createdAt };
    } catch { invalidCursor(); }
  }
  return { limit, before, fingerprint };
}

export function chronologicalPageResult<T>(rows: T[], position: ReturnType<typeof chronologicalPagePosition>, key: (row: T) => ChronologicalPosition) {
  const items = rows.slice(0, position.limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > position.limit && last
    ? Buffer.from(JSON.stringify({ v: 1, scope: position.fingerprint, ...key(last) })).toString("base64url") : null };
}

function invalidCursor(): never {
  throw new AppError("Invalid cursor for this list.", "INVALID_PAGE_CURSOR", 400);
}
