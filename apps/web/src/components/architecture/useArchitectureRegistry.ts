import { useCallback, useRef } from "react";
import type { RegistryClient } from "../../api.js";
import type {
  ArchitectureRegistryReleaseOption,
  ArchitectureRegistrySkillOption,
} from "./editor/index.js";

export function useArchitectureRegistry(client: RegistryClient): {
  searchArchitectureRegistrySkills: (query: string) => Promise<ArchitectureRegistrySkillOption[]>;
  loadArchitectureRegistryReleases: (skill: ArchitectureRegistrySkillOption) => Promise<ArchitectureRegistryReleaseOption[]>;
} {
  const registryRequestEpoch = useRef(0);

  const searchArchitectureRegistrySkills = useCallback(async (query: string): Promise<ArchitectureRegistrySkillOption[]> => {
    const rows = await client.searchSkills(query);
    return rows.map((skill) => ({
      slug: skill.slug,
      title: skill.title,
      summary: skill.summary,
      visibility: skill.visibility,
      latestVersion: skill.latestVersion,
      tags: skill.tags,
    }));
  }, [client]);

  const loadArchitectureRegistryReleases = useCallback(async (skill: ArchitectureRegistrySkillOption): Promise<ArchitectureRegistryReleaseOption[]> => {
    const requestEpoch = registryRequestEpoch.current + 1;
    registryRequestEpoch.current = requestEpoch;
    const rows = await client.listSkillReleases(skill.slug);
    const eligibleRows = rows.filter((row) => row.lifecycleStatus === "approved" && row.reviewStatus === "approved" && row.securityStatus === "passed");
    const releases = await Promise.all(eligibleRows.map(async (row) => {
      const release = await client.getRelease(row.slug, row.version);
      return {
        id: row.id,
        slug: release.slug,
        title: release.title,
        summary: release.summary,
        version: release.version,
        digest: release.artifact.sha256,
        packageVisibility: skill.visibility,
        ...(skill.tags && skill.tags.length > 0 ? { tags: skill.tags } : {}),
      };
    }));
    return requestEpoch === registryRequestEpoch.current ? releases : [];
  }, [client]);

  return { searchArchitectureRegistrySkills, loadArchitectureRegistryReleases };
}
