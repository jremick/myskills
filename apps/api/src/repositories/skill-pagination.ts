import { createHash } from "node:crypto";
import { AppError, type PublicSkill, type SkillRepository } from "@myskills-app/core";

export interface SkillPageFilters {
  query?: string;
  limit?: number;
  cursor?: string;
}

export interface SkillPage<T> {
  skills: T[];
  nextCursor: string | null;
}

export function parseSkillPageQuery(input: unknown): SkillPageFilters {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (params.cursor !== undefined && typeof params.cursor !== "string") {
    throw new AppError("Invalid skill cursor.", "INVALID_SKILL_CURSOR", 400);
  }
  const rawLimit = typeof params.limit === "string" ? Number(params.limit) : undefined;
  if (rawLimit !== undefined && (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100)) {
    throw new AppError("Skill page size must be between 1 and 100.", "INVALID_SKILL_PAGE_SIZE", 400);
  }
  return {
    query: typeof params.q === "string" ? params.q : undefined,
    limit: rawLimit,
    cursor: params.cursor as string | undefined,
  };
}

export function skillPagePosition(filters: SkillPageFilters, scope: string) {
  const query = filters.query?.trim().toLowerCase() ?? "";
  const limit = filters.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError("Skill page size must be between 1 and 100.", "INVALID_SKILL_PAGE_SIZE", 400);
  }
  const fingerprint = createHash("sha256").update(JSON.stringify([scope, query])).digest("hex");
  let afterSlug: string | undefined;
  if (filters.cursor !== undefined) {
    try {
      if (!filters.cursor || filters.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(filters.cursor)) throw new Error();
      const payload = JSON.parse(Buffer.from(filters.cursor, "base64url").toString("utf8")) as Record<string, unknown>;
      if (payload.v !== 1 || payload.scope !== fingerprint || typeof payload.after !== "string" ||
          !/^[a-z0-9][a-z0-9-]{0,127}$/.test(payload.after)) throw new Error();
      afterSlug = payload.after;
    } catch {
      throw new AppError("Invalid skill cursor for this search.", "INVALID_SKILL_CURSOR", 400);
    }
  }
  return { query, limit, afterSlug, fingerprint };
}

export function skillPageResult<T extends { slug: string }>(
  rows: T[],
  position: ReturnType<typeof skillPagePosition>,
): SkillPage<T> {
  const skills = rows.slice(0, position.limit);
  const last = skills.at(-1);
  return {
    skills,
    nextCursor: rows.length > position.limit && last
      ? Buffer.from(JSON.stringify({ v: 1, scope: position.fingerprint, after: last.slug })).toString("base64url")
      : null,
  };
}

export async function searchVisibleSkillPage(
  repository: SkillRepository,
  filters: SkillPageFilters & { actorId?: string | null },
): Promise<SkillPage<PublicSkill>> {
  const position = skillPagePosition(filters, `registry:${filters.actorId ?? "anonymous"}`);
  const rows = await repository.searchVisibleSkills({
    query: position.query,
    afterSlug: position.afterSlug,
    limit: position.limit + 1,
    actorId: filters.actorId,
  });
  return skillPageResult(rows, position);
}
