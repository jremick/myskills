import type { PublicSkill } from "@myskills-app/core";
import { RegistryApiError, type McpSession, type RegistryApiClient, type ReleaseMetadata } from "./api-client.js";

export interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface SearchSkillsInput {
  query?: string;
  limit?: number;
}

export interface SkillInfoInput {
  slug: string;
}

export interface InstallInstructionsInput {
  slug: string;
  version?: string;
  platform?: string;
}

export interface ArchitectureProjectionInput {
  id: string;
  profileId?: string;
  environmentId?: string;
  revisionId?: string;
}

export interface AiSkillsMcpHandlers {
  searchSkills(input: SearchSkillsInput): Promise<McpToolResult>;
  getSkillInfo(input: SkillInfoInput): Promise<McpToolResult>;
  getInstallInstructions(input: InstallInstructionsInput): Promise<McpToolResult>;
  listArchitecturePatterns(): Promise<McpToolResult>;
  listArchitectures(): Promise<McpToolResult>;
  getArchitectureProjection(input: ArchitectureProjectionInput): Promise<McpToolResult>;
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
const PLATFORM_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const ARCHITECTURE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ARCHITECTURE_READ_SCOPE = "architectures:read";
const ARCHITECTURE_SCOPE_ERROR = "MCP architecture tools require an API token with architectures:read scope.";

export function createAiSkillsMcpHandlers(client: RegistryApiClient): AiSkillsMcpHandlers {
  return {
    async searchSkills(input) {
      const skills = await runSafely(async () => {
        await client.authenticateMcp();
        return client.searchSkills({
          query: input.query,
          limit: boundedLimit(input.limit),
        });
      });
      if (isToolError(skills)) {
        return skills;
      }
      return toolJson({
        skills: skills.map(safeSkill),
        count: skills.length,
      });
    },

    async getSkillInfo(input) {
      const result = await runSafely(async () => {
        await client.authenticateMcp();
        const slug = parseSlug(input.slug);
        const skill = await client.getSkill(slug);
        const release = skill.latestVersion ? await client.getRelease(skill.slug, skill.latestVersion) : null;
        return {
          skill: safeSkill(skill),
          release: release ? safeRelease(release) : null,
        };
      });
      if (isToolError(result)) {
        return result;
      }
      return toolJson(result);
    },

    async getInstallInstructions(input) {
      const result = await runSafely(async () => {
        await client.authenticateMcp();
        const slug = parseSlug(input.slug);
        const requestedVersion = input.version ? parseVersion(input.version) : undefined;
        const requestedPlatform = input.platform ? parsePlatform(input.platform) : undefined;
        const skill = await client.getSkill(slug);
        const version = requestedVersion ?? skill.latestVersion;
        if (!version) {
          throw new ToolInputError("No approved release is available for that skill.");
        }
        const release = await client.getRelease(skill.slug, version);
        const selectedPlatform = selectPlatform(release, requestedPlatform);
        const outputDir = `./skills/${skill.slug}`;
        const slugArg = shellArg(skill.slug);
        const versionArg = shellArg(release.version);
        const platformArg = shellArg(selectedPlatform.name);
        const outputDirArg = shellArg(outputDir);
        return {
          skill: safeSkill(skill),
          release: safeRelease(release),
          install: {
            platform: selectedPlatform.name,
            installTarget: selectedPlatform.installTarget,
            cliInstallCommand: `myskills install ${slugArg} --version ${versionArg} --platform ${platformArg}`,
            cliExportCommand: `myskills export ${slugArg} --version ${versionArg} --platform ${platformArg} --output ${outputDirArg}`,
            apiBundleEndpoint: `${client.baseUrl}/v1/skills/${encodeURIComponent(skill.slug)}/releases/${encodeURIComponent(release.version)}/bundle?platform=${encodeURIComponent(selectedPlatform.name)}`,
            authentication: client.hasToken
              ? "This MCP server will forward its configured bearer token to the API."
              : "Configure MYSKILLS_TOKEN for authenticated or restricted registry access.",
            packageContentsReturned: false,
          },
        };
      });
      if (isToolError(result)) {
        return result;
      }
      return toolJson(result);
    },

    async listArchitecturePatterns() {
      const result = await runSafely(async () => {
        await authenticateArchitectureReader(client);
        const response = await client.listArchitecturePatterns();
        const patterns = safeArchitecturePatterns(response);
        return {
          patterns,
          count: patterns.length,
        };
      }, ARCHITECTURE_SCOPE_ERROR);
      if (isToolError(result)) {
        return result;
      }
      return toolJson(result);
    },

    async listArchitectures() {
      const result = await runSafely(async () => {
        await authenticateArchitectureReader(client);
        const response = await client.listArchitectures();
        const architectures = safeArchitectures(response);
        return { architectures, count: architectures.length };
      }, ARCHITECTURE_SCOPE_ERROR);
      if (isToolError(result)) {
        return result;
      }
      return toolJson(result);
    },

    async getArchitectureProjection(input) {
      const result = await runSafely(async () => {
        await authenticateArchitectureReader(client);
        const id = parseArchitectureId(input.id);
        const architecture = await client.getArchitecture(id);
        const preview = await client.previewArchitecture(id, {
          ...(input.profileId ? { profileId: parseArchitectureId(input.profileId) } : {}),
          ...(input.environmentId ? { environmentId: parseArchitectureId(input.environmentId) } : {}),
          ...(input.revisionId ? { revisionId: parseArchitectureId(input.revisionId) } : {}),
        });
        return {
          architecture: safeArchitecture(architecture),
          preview: safeArchitecturePreview(preview),
        };
      }, ARCHITECTURE_SCOPE_ERROR);
      if (isToolError(result)) {
        return result;
      }
      return toolJson(result);
    },
  };
}

function safeSkill(skill: PublicSkill): PublicSkill {
  return {
    slug: skill.slug,
    title: skill.title,
    summary: skill.summary,
    lifecycleStatus: skill.lifecycleStatus,
    visibility: skill.visibility,
    latestVersion: skill.latestVersion,
    reviewStatus: skill.reviewStatus,
    securityStatus: skill.securityStatus,
    platforms: skill.platforms.map((platform) => ({
      name: platform.name,
      installTarget: platform.installTarget,
      status: platform.status,
    })),
    tags: [...skill.tags],
  };
}

function safeRelease(release: ReleaseMetadata): ReleaseMetadata {
  return {
    slug: release.slug,
    title: release.title,
    summary: release.summary,
    version: release.version,
    reviewStatus: release.reviewStatus,
    securityStatus: release.securityStatus,
    publishedAt: release.publishedAt,
    platforms: release.platforms.map((platform) => ({
      name: platform.name,
      installTarget: platform.installTarget,
      status: platform.status,
    })),
    artifact: {
      sha256: release.artifact.sha256,
      byteSize: release.artifact.byteSize,
      contentType: release.artifact.contentType,
    },
  };
}

function safeArchitecturePatterns(response: Record<string, unknown>): Array<Record<string, unknown>> {
  return arrayField(response, "patterns").map((value) => {
    const pattern = recordField(value);
    return {
      ...(stringField(pattern, "id") ? { id: stringField(pattern, "id") } : {}),
      ...(stringField(pattern, "key") ? { key: stringField(pattern, "key") } : {}),
      ...(stringField(pattern, "name") ? { name: stringField(pattern, "name") } : {}),
      ...(stringField(pattern, "title") ? { title: stringField(pattern, "title") } : {}),
      ...(stringField(pattern, "description") ? { description: stringField(pattern, "description") } : {}),
      ...(stringField(pattern, "status") ? { status: stringField(pattern, "status") } : {}),
      ...(numberField(pattern, "maxRouterDepth") !== undefined ? { maxRouterDepth: numberField(pattern, "maxRouterDepth") } : {}),
      ...(booleanField(pattern, "supportsNestedRouters") !== undefined ? { supportsNestedRouters: booleanField(pattern, "supportsNestedRouters") } : {}),
    };
  });
}

function safeArchitectures(response: Record<string, unknown>): Array<Record<string, unknown>> {
  return arrayField(response, "architectures").map((value) => safeArchitecture(value));
}

function safeArchitecture(input: unknown): Record<string, unknown> {
  const source = recordField(input && typeof input === "object" && !Array.isArray(input) && "architecture" in input
    ? (input as Record<string, unknown>).architecture
    : input);
  return {
    ...(stringField(source, "id") ? { id: stringField(source, "id") } : {}),
    ...(stringField(source, "name") ? { name: stringField(source, "name") } : {}),
    ...(stringField(source, "title") ? { title: stringField(source, "title") } : {}),
    ...(stringField(source, "description") ? { description: stringField(source, "description") } : {}),
    ...(stringField(source, "patternId") ? { patternId: stringField(source, "patternId") } : {}),
    ...(stringField(source, "scope") ? { scope: stringField(source, "scope") } : {}),
    ...(stringField(source, "status") ? { status: stringField(source, "status") } : {}),
    ...(stringField(source, "currentRevisionId") ? { currentRevisionId: stringField(source, "currentRevisionId") } : {}),
    ...(numberField(source, "revisionCount") !== undefined ? { revisionCount: numberField(source, "revisionCount") } : {}),
    ...(stringField(source, "updatedAt") ? { updatedAt: stringField(source, "updatedAt") } : {}),
    ...(arrayField(source, "revisions").length > 0
      ? { revisions: arrayField(source, "revisions").map((value) => safeRevision(value)) }
      : {}),
  };
}

function safeRevision(input: unknown): Record<string, unknown> {
  const revision = recordField(input);
  return {
    ...(stringField(revision, "id") ? { id: stringField(revision, "id") } : {}),
    ...(stringField(revision, "architectureId") ? { architectureId: stringField(revision, "architectureId") } : {}),
    ...(numberField(revision, "revision") !== undefined ? { revision: numberField(revision, "revision") } : {}),
    ...(numberField(revision, "revisionNumber") !== undefined ? { revisionNumber: numberField(revision, "revisionNumber") } : {}),
    ...(stringField(revision, "version") ? { version: stringField(revision, "version") } : {}),
    ...(stringField(revision, "message") ? { message: stringField(revision, "message") } : {}),
    ...(stringField(revision, "patternId") ? { patternId: stringField(revision, "patternId") } : {}),
    ...(numberField(revision, "nodeCount") !== undefined ? { nodeCount: numberField(revision, "nodeCount") } : {}),
    ...(numberField(revision, "skillCount") !== undefined ? { skillCount: numberField(revision, "skillCount") } : {}),
    ...(stringField(revision, "createdAt") ? { createdAt: stringField(revision, "createdAt") } : {}),
  };
}

function safeArchitecturePreview(input: Record<string, unknown>): Record<string, unknown> {
  const preview = recordField(input.preview ?? input);
  const revision = recordField(preview.revision);
  const topology = recordFieldOrEmpty(preview.topology);
  const graph = recordFieldOrEmpty(preview.graph);
  const compiled = recordFieldOrEmpty(preview.compiled);
  const effective = recordFieldOrEmpty(preview.effective);
  const exposure = recordFieldOrEmpty(preview.exposure);
  const graphProjection = Object.keys(graph).length > 0 ? safeArchitectureGraph(graph) : undefined;
  const topologySource = Object.keys(topology).length > 0 ? topology : graph;
  const topologyNodes = arrayField(topologySource, "nodes");
  const topologyEdges = arrayField(topologySource, "edges");
  const outline = safeArchitectureOutline(preview.outline);
  const planSource = recordField(preview.plan ?? preview.syncPlan);
  const architectureId = stringField(revision, "architectureId") ?? stringField(preview, "architectureId") ?? stringField(compiled, "architectureId");
  const revisionId = stringField(revision, "id") ?? stringField(preview, "revisionId");
  const revisionNumber = numberField(revision, "revisionNumber");
  return {
    ...(architectureId ? { architectureId } : {}),
    ...(revisionId ? { revisionId } : {}),
    ...(revisionNumber !== undefined ? { revisionNumber } : {}),
    ...(numberField(preview, "revision") !== undefined ? { revision: numberField(preview, "revision") } : {}),
    ...(stringField(preview, "mermaid") ? { mermaid: stringField(preview, "mermaid") } : {}),
    ...(graphProjection ? { graph: graphProjection } : {}),
    topology: {
      nodes: (topologyNodes.length > 0 ? topologyNodes : arrayField(compiled, "nodes"))
        .map((value) => safeTopologyNode(value)),
      edges: (topologyEdges.length > 0 ? topologyEdges : arrayField(compiled, "edges"))
        .map((value) => safeTopologyEdge(value)),
    },
    ...(outline ? { outline } : {}),
    ...(Object.keys(compiled).length > 0 ? { compiled: safeCompiled(compiled) } : {}),
    ...(Object.keys(effective).length > 0 ? { effective: safeEffective(effective) } : {}),
    ...(Object.keys(exposure).length > 0 ? { exposure: safeExposure(exposure) } : {}),
    ...(Object.keys(planSource).length > 0 ? { plan: safeArchitecturePlan(planSource) } : {}),
  };
}

function safeArchitectureGraph(input: Record<string, unknown>): Record<string, unknown> {
  const graph = recordField(input.graph ?? input);
  return {
    ...(stringField(graph, "digest") ? { digest: stringField(graph, "digest") } : {}),
    nodes: arrayField(graph, "nodes").map((value) => safeTopologyNode(value)),
    edges: arrayField(graph, "edges").map((value) => safeTopologyEdge(value)),
    ...(stringField(graph, "mermaid") ? { mermaid: stringField(graph, "mermaid") } : {}),
  };
}

function safeArchitectureOutline(input: unknown): Array<Record<string, unknown>> | undefined {
  if (Array.isArray(input)) {
    return input.length > 0 ? input.map((value) => safeOutlineNode(value)) : undefined;
  }
  const outline = recordField(input);
  const tree = arrayField(outline, "tree");
  return tree.length > 0 ? tree.map((value) => safeOutlineNode(value)) : undefined;
}

function safeTopologyNode(input: unknown): Record<string, unknown> {
  const node = recordField(input);
  return {
    ...(stringField(node, "id") ? { id: stringField(node, "id") } : {}),
    ...(stringField(node, "kind") ? { kind: stringField(node, "kind") } : {}),
    ...(stringField(node, "label") ? { label: stringField(node, "label") } : {}),
    ...(stringField(node, "slug") ? { slug: stringField(node, "slug") } : {}),
    ...(stringField(node, "skillRefId") ? { skillRefId: stringField(node, "skillRefId") } : {}),
    ...(stringField(node, "title") ? { title: stringField(node, "title") } : {}),
    ...(stringField(node, "description") ? { description: stringField(node, "description") } : {}),
    ...(numberField(node, "depth") !== undefined ? { depth: numberField(node, "depth") } : {}),
    ...(numberField(node, "x") !== undefined ? { x: numberField(node, "x") } : {}),
    ...(numberField(node, "y") !== undefined ? { y: numberField(node, "y") } : {}),
  };
}

function safeTopologyEdge(input: unknown): Record<string, unknown> {
  const edge = recordField(input);
  return {
    ...(stringField(edge, "id") ? { id: stringField(edge, "id") } : {}),
    ...(stringField(edge, "from") ? { from: stringField(edge, "from") } : {}),
    ...(stringField(edge, "to") ? { to: stringField(edge, "to") } : {}),
    ...(stringField(edge, "relationship") ? { relationship: stringField(edge, "relationship") } : {}),
    ...(stringField(edge, "kind") ? { kind: stringField(edge, "kind") } : {}),
    ...(stringField(edge, "label") ? { label: stringField(edge, "label") } : {}),
  };
}

function safeOutlineNode(input: unknown): Record<string, unknown> {
  const node = recordField(input);
  return {
    ...(stringField(node, "id") ? { id: stringField(node, "id") } : {}),
    ...(stringField(node, "kind") ? { kind: stringField(node, "kind") } : {}),
    ...(stringField(node, "label") ? { label: stringField(node, "label") } : {}),
    ...(stringField(node, "skillRefId") ? { skillRefId: stringField(node, "skillRefId") } : {}),
    ...(numberField(node, "depth") !== undefined ? { depth: numberField(node, "depth") } : {}),
    ...(arrayField(node, "children").length > 0
      ? { children: arrayField(node, "children").map((value) => safeOutlineNode(value)) }
      : {}),
  };
}

function safeArchitecturePlan(input: Record<string, unknown>): Record<string, unknown> {
  const plan = recordField(input.plan ?? input);
  const items = arrayField(plan, "items");
  const changes = arrayField(plan, "changes");
  const summary = safePlanSummary(plan.summary);
  return {
    ...(stringField(plan, "status") ? { status: stringField(plan, "status") } : {}),
    ...(stringField(plan, "target") ? { target: stringField(plan, "target") } : {}),
    ...(booleanField(plan, "dryRun") !== undefined ? { dryRun: booleanField(plan, "dryRun") } : {}),
    ...(booleanField(plan, "canApply") !== undefined ? { canApply: booleanField(plan, "canApply") } : {}),
    ...(booleanField(plan, "requiresApproval") !== undefined ? { requiresApproval: booleanField(plan, "requiresApproval") } : {}),
    ...(stringField(plan, "targetId") ? { targetId: stringField(plan, "targetId") } : {}),
    ...(stringField(plan, "environmentId") ? { environmentId: stringField(plan, "environmentId") } : {}),
    ...(stringField(plan, "architectureId") ? { architectureId: stringField(plan, "architectureId") } : {}),
    ...(stringField(plan, "revisionDigest") ? { revisionDigest: stringField(plan, "revisionDigest") } : {}),
    ...(summary ? { summary } : {}),
    ...(items.length > 0 ? { items: items.map((value) => safeArchitecturePlanItem(value)) } : {}),
    ...(changes.length > 0 ? { changes: changes.map((value) => safeArchitecturePlanChange(value)) } : {}),
  };
}

function safeArchitecturePlanItem(input: unknown): Record<string, unknown> {
  const item = recordField(input);
  const desired = safeArchitecturePlanState(item.desired);
  const observed = safeArchitecturePlanState(item.observed);
  return {
    ...(stringField(item, "action") ? { action: stringField(item, "action") } : {}),
    ...(stringField(item, "type") ? { type: stringField(item, "type") } : {}),
    ...(stringField(item, "nodeId") ? { nodeId: stringField(item, "nodeId") } : {}),
    ...(stringField(item, "kind") ? { kind: stringField(item, "kind") } : {}),
    ...(stringField(item, "skillRefId") ? { skillRefId: stringField(item, "skillRefId") } : {}),
    ...(stringField(item, "reason") ? { reason: stringField(item, "reason") } : {}),
    ...(desired ? { desired } : {}),
    ...(observed ? { observed } : {}),
  };
}

function safeArchitecturePlanState(input: unknown): Record<string, unknown> | undefined {
  const state = recordField(input);
  if (Object.keys(state).length === 0) return undefined;
  return {
    ...(stringField(state, "version") ? { version: stringField(state, "version") } : {}),
    ...(stringField(state, "digest") ? { digest: stringField(state, "digest") } : {}),
    ...(booleanField(state, "enabled") !== undefined ? { enabled: booleanField(state, "enabled") } : {}),
    ...(stringField(state, "runtimeExposure") ? { runtimeExposure: stringField(state, "runtimeExposure") } : {}),
  };
}

function safeArchitecturePlanChange(input: unknown): Record<string, unknown> {
  const change = recordField(input);
  return {
    ...(stringField(change, "id") ? { id: stringField(change, "id") } : {}),
    ...(stringField(change, "type") ? { type: stringField(change, "type") } : {}),
    ...(stringField(change, "action") ? { action: stringField(change, "action") } : {}),
    ...(stringField(change, "subject") ? { subject: stringField(change, "subject") } : {}),
    ...(stringField(change, "detail") ? { detail: stringField(change, "detail") } : {}),
    ...(stringField(change, "severity") ? { severity: stringField(change, "severity") } : {}),
  };
}

function safePlanSummary(input: unknown): Record<string, number> | undefined {
  const summary = recordField(input);
  const result: Record<string, number> = {};
  for (const key of ["changeCount", "installCount", "updateCount", "removeCount", "unsupportedCount", "conflictCount"] as const) {
    const value = numberField(summary, key);
    if (value !== undefined) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function safeCompiled(compiled: Record<string, unknown>): Record<string, unknown> {
  const pattern = recordFieldOrEmpty(compiled.pattern);
  return {
    ...(stringField(pattern, "id") ? { patternId: stringField(pattern, "id") } : {}),
    ...(stringField(compiled, "rootNodeId") ? { rootNodeId: stringField(compiled, "rootNodeId") } : {}),
    ...(stringField(compiled, "profileId") ? { profileId: stringField(compiled, "profileId") } : {}),
    ...(stringField(compiled, "environmentId") ? { environmentId: stringField(compiled, "environmentId") } : {}),
    ...(arrayField(compiled, "skills").length > 0
      ? { skills: arrayField(compiled, "skills").map((value) => safeCompiledSkill(value)) }
      : {}),
    ...(stringField(compiled, "entrypoint") ? { entrypoint: stringField(compiled, "entrypoint") } : {}),
    ...(stringField(compiled, "bundleName") ? { bundleName: stringField(compiled, "bundleName") } : {}),
    ...(stringField(compiled, "revisionDigest") ? { digest: stringField(compiled, "revisionDigest") } : {}),
  };
}

function safeCompiledSkill(input: unknown): Record<string, unknown> {
  const skill = recordField(input);
  return {
    ...(stringField(skill, "id") ? { id: stringField(skill, "id") } : {}),
    ...(stringField(skill, "slug") ? { slug: stringField(skill, "slug") } : {}),
    ...(stringField(skill, "title") ? { title: stringField(skill, "title") } : {}),
    ...(stringField(skill, "version") ? { version: stringField(skill, "version") } : {}),
    ...(stringField(skill, "digest") ? { digest: stringField(skill, "digest") } : {}),
    ...(stringField(skill, "exposure") ? { exposure: stringField(skill, "exposure") } : {}),
    ...(stringField(skill, "reason") ? { reason: stringField(skill, "reason") } : {}),
  };
}

function safeEffective(effective: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(arrayField(effective, "skills").length > 0
      ? { skills: arrayField(effective, "skills").map((value) => safeCompiledSkill(value)) }
      : {}),
    ...(arrayField(effective, "includedSkills").length > 0
      ? { includedSkills: arrayField(effective, "includedSkills").map((value) => safeCompiledSkill(value)) }
      : {}),
    ...(arrayField(effective, "excludedSkills").length > 0
      ? { excludedSkills: arrayField(effective, "excludedSkills").map((value) => safeCompiledSkill(value)) }
      : {}),
    ...(stringField(effective, "summary") ? { summary: stringField(effective, "summary") } : {}),
  };
}

function safeExposure(exposure: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(stringField(exposure, "summary") ? { summary: stringField(exposure, "summary") } : {}),
    ...(stringArrayField(exposure, "included") ? { included: stringArrayField(exposure, "included") } : {}),
    ...(stringArrayField(exposure, "excluded") ? { excluded: stringArrayField(exposure, "excluded") } : {}),
  };
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(record[key]) ? record[key] as unknown[] : [];
}

function recordField(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  return input as Record<string, unknown>;
}

function recordFieldOrEmpty(input: unknown): Record<string, unknown> {
  return recordField(input);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return undefined;
  }
  return value as string[];
}

function selectPlatform(release: ReleaseMetadata, requestedPlatform: string | undefined): { name: string; installTarget: string; status: string } {
  const supportedPlatforms = release.platforms.filter((item) => item.status === "supported");
  const platform = requestedPlatform
    ? supportedPlatforms.find((item) => item.name === requestedPlatform)
    : supportedPlatforms.find((item) => item.name === "codex") ?? supportedPlatforms[0];
  if (requestedPlatform && !platform) {
    throw new ToolInputError("Requested platform is not supported for that release.");
  }
  if (!platform) {
    throw new ToolInputError("No supported platform is available for that release.");
  }
  return platform;
}

async function authenticateArchitectureReader(client: RegistryApiClient): Promise<McpSession> {
  const session = await client.authenticateMcp();
  if (!session.credential.scopes.includes(ARCHITECTURE_READ_SCOPE)) {
    throw new ToolScopeError(ARCHITECTURE_SCOPE_ERROR);
  }
  return session;
}

async function runSafely<T>(operation: () => Promise<T>, requiredScope?: string): Promise<T | McpToolResult> {
  try {
    return await operation();
  } catch (error) {
    return toolError(safeErrorMessage(error, requiredScope));
  }
}

function safeErrorMessage(error: unknown, requiredScope?: string): string {
  if (error instanceof ToolInputError || error instanceof ToolScopeError) {
    return error.message;
  }
  if (error instanceof RegistryApiError && error.status === 404) {
    return "Skill or release not found.";
  }
  if (error instanceof RegistryApiError && (error.status === 401 || error.status === 403)) {
    if (requiredScope) {
      return `MCP architecture tools require an API token with ${requiredScope} scope.`;
    }
    return "MCP authentication requires an API token with skills:read scope.";
  }
  if (error instanceof RegistryApiError && error.status >= 400 && error.status < 500) {
    return "The registry request could not be completed.";
  }
  return "The registry is not available.";
}

function toolJson(value: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function toolError(message: string): McpToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: message },
  };
}

function isToolError(value: unknown): value is McpToolResult {
  return Boolean(value && typeof value === "object" && "isError" in value);
}

function parseSlug(value: string): string {
  if (!SLUG_PATTERN.test(value)) {
    throw new ToolInputError("Skill slug is invalid.");
  }
  return value;
}

function parseVersion(value: string): string {
  if (!VERSION_PATTERN.test(value)) {
    throw new ToolInputError("Version is invalid.");
  }
  return value;
}

function parsePlatform(value: string): string {
  if (value.length > 64 || !PLATFORM_PATTERN.test(value)) {
    throw new ToolInputError("Platform is invalid.");
  }
  return value;
}

function parseArchitectureId(value: string): string {
  if (value.length > 120 || !ARCHITECTURE_ID_PATTERN.test(value)) {
    throw new ToolInputError("Architecture id is invalid.");
  }
  return value;
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function boundedLimit(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Math.min(Math.max(Math.trunc(value), 1), 100);
}

class ToolInputError extends Error {}

class ToolScopeError extends Error {}
