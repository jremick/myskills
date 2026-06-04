import { and, eq, ilike, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { PublicSkill, SkillRepository, SkillSearchFilters, SkillPlatformVariant } from "@ai-skills-share/core";
import type { Database } from "../db/client.js";
import { skillArtifacts, skillPlatformVariants, skills, skillTags, skillVersions } from "../db/schema.js";

export class PostgresSkillRepository implements SkillRepository {
  constructor(private readonly db: Database) {}

  async searchVisibleSkills(filters: SkillSearchFilters = {}): Promise<PublicSkill[]> {
    const query = filters.query?.trim() ?? "";
    const limit = filters.limit ?? 50;
    const where = and(
      visibleReleasedSkillPredicate(),
      query
        ? or(
            ilike(skills.slug, `%${query}%`),
            ilike(skills.title, `%${query}%`),
            ilike(skills.summary, `%${query}%`),
          )
        : undefined,
    );

    return uniqueBySlug(await this.visibleSkillRows(where, limit * 5)).slice(0, limit);
  }

  async getVisibleSkillBySlug(slug: string): Promise<PublicSkill | null> {
    const rows = await this.visibleSkillRows(and(
      eq(skills.slug, slug),
      visibleReleasedSkillPredicate(),
    ), 1);
    return rows[0] ?? null;
  }

  private async visibleSkillRows(where: SQL | undefined, limit: number): Promise<PublicSkill[]> {
    const rows = await this.db
      .select({
        slug: skills.slug,
        title: skills.title,
        summary: skills.summary,
        lifecycleStatus: skills.lifecycleStatus,
        visibility: skills.visibility,
        latestVersion: skillVersions.version,
        reviewStatus: skillVersions.reviewStatus,
        securityStatus: skillVersions.securityStatus,
        platforms: sql<SkillPlatformVariant[]>`
          coalesce(
            json_agg(
              json_build_object(
                'name', ${skillPlatformVariants.name},
                'installTarget', ${skillPlatformVariants.installTarget},
                'status', ${skillPlatformVariants.status}
              )
            ) filter (where ${skillPlatformVariants.id} is not null),
            '[]'::json
          )
        `,
        tags: sql<string[]>`
          coalesce(
            array_agg(distinct ${skillTags.tag}) filter (where ${skillTags.tag} is not null),
            '{}'::text[]
          )
        `,
      })
      .from(skills)
      .innerJoin(skillVersions, eq(skillVersions.skillId, skills.id))
      .innerJoin(skillArtifacts, eq(skillArtifacts.skillVersionId, skillVersions.id))
      .leftJoin(skillPlatformVariants, eq(skillPlatformVariants.skillVersionId, skillVersions.id))
      .leftJoin(skillTags, eq(skillTags.skillId, skills.id))
      .where(where)
      .groupBy(
        skills.slug,
        skills.title,
        skills.summary,
        skills.lifecycleStatus,
        skills.visibility,
        skillVersions.version,
        skillVersions.reviewStatus,
        skillVersions.securityStatus,
        skillVersions.createdAt,
      )
      .orderBy(sql`${skillVersions.createdAt} desc`, skills.title)
      .limit(limit);

    return rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      lifecycleStatus: row.lifecycleStatus,
      visibility: row.visibility,
      latestVersion: row.latestVersion,
      reviewStatus: row.reviewStatus,
      securityStatus: row.securityStatus,
      platforms: dedupePlatforms(row.platforms),
      tags: row.tags,
    }));
  }
}

function visibleReleasedSkillPredicate(): SQL | undefined {
  return and(
    eq(skills.lifecycleStatus, "approved"),
    eq(skills.visibility, "public"),
    eq(skillVersions.reviewStatus, "approved"),
    eq(skillVersions.securityStatus, "passed"),
    isNotNull(skillVersions.publishedAt),
  );
}

function uniqueBySlug(skills: PublicSkill[]): PublicSkill[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    if (seen.has(skill.slug)) {
      return false;
    }
    seen.add(skill.slug);
    return true;
  });
}

function dedupePlatforms(platforms: SkillPlatformVariant[]): SkillPlatformVariant[] {
  const seen = new Set<string>();
  return platforms.filter((platform) => {
    const key = `${platform.name}:${platform.installTarget}:${platform.status}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
