import {
  architectureSchemaVersion,
  type ArchitectureEdge,
  type ArchitectureEnvironment,
  type ArchitectureEnvironmentKind,
  type ArchitectureLeafNode,
  type ArchitectureMetadata,
  type ArchitectureNode,
  type ArchitecturePackageVisibility,
  type ArchitecturePatternId,
  type ArchitectureProfile,
  type ArchitectureRouterNode,
  type ArchitectureSkillRef,
  type ArchitectureSpecV1,
  type ArchitectureSubjectKind,
} from "./architecture-contracts.js";
import { assertValidArchitectureSpec } from "./architecture-validation.js";
import { canonicalizeJson, sha256Hex } from "./architecture-canonical.js";

export interface ArchitectureFactorySkillInput extends Omit<Partial<ArchitectureSkillRef>, "id" | "slug" | "version" | "digest" | "packageVisibility"> {
  id?: string;
  slug: string;
  version?: string;
  digest?: string;
  packageVisibility?: ArchitecturePackageVisibility;
  /** Compatibility alias for packageVisibility. */
  visibility?: ArchitecturePackageVisibility;
  domainId?: string;
}

export interface ArchitectureDomainInput {
  id: string;
  label?: string;
  skillIds?: string[];
}

export interface ArchitectureFactoryInput {
  id: string;
  name: string;
  description?: string;
  skills: ArchitectureFactorySkillInput[];
  domains?: ArchitectureDomainInput[];
  profile?: {
    id?: string;
    name?: string;
    subject?: { type: ArchitectureSubjectKind; id: string };
  };
  environment?: {
    id?: string;
    name?: string;
    kind?: ArchitectureEnvironmentKind;
  };
  metadata?: ArchitectureMetadata;
}

function factoryDigest(skill: ArchitectureFactorySkillInput, version: string, title: string): string {
  return sha256Hex(canonicalizeJson({ slug: skill.slug, title, version, summary: skill.summary ?? "" }));
}

function buildFactorySpec(input: ArchitectureFactoryInput, pattern: ArchitecturePatternId, nodes: ArchitectureNode[], edges: ArchitectureEdge[], entryNodeIds: string[]): ArchitectureSpecV1 {
  const profileId = input.profile?.id ?? `${input.id}-profile`;
  const environmentId = input.environment?.id ?? `${input.id}-personal`;
  const profile: ArchitectureProfile = {
    id: profileId,
    name: input.profile?.name ?? "Personal profile",
    subject: input.profile?.subject ?? { type: "user", id: "local-user" },
    defaultExposure: "disabled",
    bindings: nodes.map((node) => ({
      nodeId: node.id,
      enabled: true,
      runtimeExposure: node.kind,
    })),
  };
  const environment: ArchitectureEnvironment = {
    id: environmentId,
    name: input.environment?.name ?? "Personal",
    kind: input.environment?.kind ?? "personal",
    profileId,
  };
  const spec: ArchitectureSpecV1 = {
    schemaVersion: architectureSchemaVersion,
    id: input.id,
    name: input.name,
    pattern: { id: pattern, version: architectureSchemaVersion },
    skills: input.skills.map((skill) => {
      const version = skill.version ?? "0.0.0";
      const title = skill.title ?? skill.slug;
      return {
        id: skill.id ?? skill.slug,
        slug: skill.slug,
        title,
        summary: skill.summary,
        version,
        digest: skill.digest ?? factoryDigest(skill, version, title),
        packageVisibility: skill.packageVisibility ?? skill.visibility ?? "private",
        tags: skill.tags,
        metadata: skill.metadata,
      };
    }),
    nodes,
    edges,
    entryNodeIds,
    profiles: [profile],
    environments: [environment],
    metadata: input.metadata,
  };
  if (input.description !== undefined) spec.description = input.description;
  return assertValidArchitectureSpec(spec);
}

export function createFlatArchitecture(input: ArchitectureFactoryInput): ArchitectureSpecV1 {
  const nodes: ArchitectureNode[] = input.skills.map((skill) => ({
    id: `leaf-${skill.id ?? skill.slug}`,
    kind: "leaf",
    label: skill.title ?? skill.slug,
    skillRefId: skill.id ?? skill.slug,
  }));
  return buildFactorySpec(input, "flat", nodes, [], nodes.map((node) => node.id));
}

export function createDomainRouterArchitecture(input: ArchitectureFactoryInput): ArchitectureSpecV1 {
  const router: ArchitectureRouterNode = { id: "router-root", kind: "router", label: input.name };
  const leaves: ArchitectureLeafNode[] = input.skills.map((skill) => ({
    id: `leaf-${skill.id ?? skill.slug}`,
    kind: "leaf",
    label: skill.title ?? skill.slug,
    skillRefId: skill.id ?? skill.slug,
  }));
  const edges = leaves.map((leaf): ArchitectureEdge => ({ from: router.id, to: leaf.id, kind: "routes" }));
  return buildFactorySpec(input, "domain-router", [router, ...leaves], edges, [router.id]);
}

function domainsForInput(input: ArchitectureFactoryInput): ArchitectureDomainInput[] {
  if (input.domains && input.domains.length > 0) return input.domains;
  const domainIds = [...new Set(input.skills.map((skill) => skill.domainId ?? "general"))];
  return domainIds.map((id) => ({ id, label: id }));
}

export function createMultiLevelRouterArchitecture(input: ArchitectureFactoryInput): ArchitectureSpecV1 {
  const root: ArchitectureRouterNode = { id: "router-root", kind: "router", label: input.name };
  const domains = domainsForInput(input);
  const nodes: ArchitectureNode[] = [root];
  const edges: ArchitectureEdge[] = [];
  for (const domain of domains) {
    const domainNode: ArchitectureRouterNode = { id: `router-${domain.id}`, kind: "router", label: domain.label ?? domain.id };
    nodes.push(domainNode);
    edges.push({ from: root.id, to: domainNode.id, kind: "contains" });
    const selectedSkills = input.skills.filter((skill) => {
      const skillId = skill.id ?? skill.slug;
      return (skill.domainId ?? "general") === domain.id || domain.skillIds?.includes(skillId) === true;
    });
    for (const skill of selectedSkills) {
      const leaf: ArchitectureLeafNode = {
        id: `leaf-${skill.id ?? skill.slug}`,
        kind: "leaf",
        label: skill.title ?? skill.slug,
        skillRefId: skill.id ?? skill.slug,
      };
      nodes.push(leaf);
      edges.push({ from: domainNode.id, to: leaf.id, kind: "routes" });
    }
  }
  return buildFactorySpec(input, "multi-level-router", nodes, edges, [root.id]);
}

export function createArchitectureFromPattern(pattern: ArchitecturePatternId, input: ArchitectureFactoryInput): ArchitectureSpecV1 {
  if (pattern === "flat") return createFlatArchitecture(input);
  if (pattern === "domain-router") return createDomainRouterArchitecture(input);
  return createMultiLevelRouterArchitecture(input);
}

export const createFlatPattern = createFlatArchitecture;
export const createDomainRouterPattern = createDomainRouterArchitecture;
export const createMultiLevelRouterPattern = createMultiLevelRouterArchitecture;
export const architecturePatternFactory = createArchitectureFromPattern;
