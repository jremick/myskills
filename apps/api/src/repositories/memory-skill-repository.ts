import type { PublicSkill, SkillRepository, SkillSearchFilters } from "@ai-skills-share/core";

export class MemorySkillRepository implements SkillRepository {
  constructor(private readonly skills: PublicSkill[]) {}

  async searchVisibleSkills(filters: SkillSearchFilters = {}): Promise<PublicSkill[]> {
    const query = filters.query?.trim().toLowerCase() ?? "";
    const limit = filters.limit ?? 50;
    return this.skills
      .filter((skill) => isVisibleReleasedSkill(skill))
      .filter((skill) => !query || [
        skill.slug,
        skill.title,
        skill.summary,
        skill.latestVersion ?? "",
        ...skill.tags,
        ...skill.platforms.map((platform) => platform.name),
      ].some((value) => value.toLowerCase().includes(query)))
      .slice(0, limit);
  }

  async getVisibleSkillBySlug(slug: string): Promise<PublicSkill | null> {
    return this.skills.find((skill) => (
      skill.slug === slug &&
      isVisibleReleasedSkill(skill)
    )) ?? null;
  }
}

function isVisibleReleasedSkill(skill: PublicSkill): boolean {
  return (
    skill.visibility === "public" &&
    skill.lifecycleStatus === "approved" &&
    skill.reviewStatus === "approved" &&
    skill.securityStatus === "passed" &&
    Boolean(skill.latestVersion)
  );
}
