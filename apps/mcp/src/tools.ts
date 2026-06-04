import type { PublicSkill } from "@ai-skills-share/core";
import { RegistryApiError, type RegistryApiClient, type ReleaseMetadata } from "./api-client.js";

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

export interface AiSkillsMcpHandlers {
  searchSkills(input: SearchSkillsInput): Promise<McpToolResult>;
  getSkillInfo(input: SkillInfoInput): Promise<McpToolResult>;
  getInstallInstructions(input: InstallInstructionsInput): Promise<McpToolResult>;
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
const PLATFORM_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

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
        return {
          skill: safeSkill(skill),
          release: safeRelease(release),
          install: {
            platform: selectedPlatform.name,
            installTarget: selectedPlatform.installTarget,
            cliInstallCommand: `ai-skills install ${skill.slug} --version ${release.version} --platform ${selectedPlatform.name}`,
            cliExportCommand: `ai-skills export ${skill.slug} --version ${release.version} --platform ${selectedPlatform.name} --output ${outputDir}`,
            apiBundleEndpoint: `${client.baseUrl}/v1/skills/${encodeURIComponent(skill.slug)}/releases/${encodeURIComponent(release.version)}/bundle?platform=${encodeURIComponent(selectedPlatform.name)}`,
            authentication: client.hasToken
              ? "This MCP server will forward its configured bearer token to the API."
              : "Configure AI_SKILLS_TOKEN for authenticated or restricted registry access.",
            packageContentsReturned: false,
          },
        };
      });
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

function selectPlatform(release: ReleaseMetadata, requestedPlatform: string | undefined): { name: string; installTarget: string; status: string } {
  const platform = requestedPlatform
    ? release.platforms.find((item) => item.name === requestedPlatform)
    : release.platforms.find((item) => item.name === "codex") ?? release.platforms[0];
  if (requestedPlatform && !platform) {
    throw new ToolInputError("Requested platform is not available for that release.");
  }
  if (!platform) {
    throw new ToolInputError("No supported platform is available for that release.");
  }
  return platform;
}

async function runSafely<T>(operation: () => Promise<T>): Promise<T | McpToolResult> {
  try {
    return await operation();
  } catch (error) {
    return toolError(safeErrorMessage(error));
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof ToolInputError) {
    return error.message;
  }
  if (error instanceof RegistryApiError && error.status === 404) {
    return "Skill or release not found.";
  }
  if (error instanceof RegistryApiError && (error.status === 401 || error.status === 403)) {
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
  if (!PLATFORM_PATTERN.test(value)) {
    throw new ToolInputError("Platform is invalid.");
  }
  return value;
}

function boundedLimit(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Math.min(Math.max(Math.trunc(value), 1), 100);
}

class ToolInputError extends Error {}
