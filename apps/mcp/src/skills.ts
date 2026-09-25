import { createHash } from "node:crypto";
import { parseSemanticVersion } from "@myskills-app/core";
import {
  loadStoredSkillManifestFromPackageFiles, MAX_PACKAGE_FILES, MAX_PACKAGE_TEXT_BYTES,
  normalizePackageFilePath, scanPackageFiles, skillSlugSchema, validatePortableFilePaths,
} from "@myskills-app/skill-package";
import { ProtocolError } from "@modelcontextprotocol/server";
import { isScalar, parseDocument, visit } from "yaml";
import { z } from "zod";
import {
  createNativeRegistryApiClient, createRegistryApiClient, NATIVE_API_BUNDLE_BYTES, RegistryApiError,
  type NativeMcpMethod, type RegistryApiClientOptions,
} from "./api-client.js";

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
export const NATIVE_SKILL_PAGE_SIZE = 5;
export const NATIVE_RESOURCE_URI_CHARS = 4096;
const privateResult = { resultType: "complete" as const, ttlMs: 0, cacheScope: "private" as const };
const versionSchema = z.string().min(1).max(80).refine((value) => parseSemanticVersion(value) !== null);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const platformSchema = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/), installTarget: z.string(), status: z.string() });
const releaseSchema = z.object({
  slug: skillSlugSchema, version: versionSchema, reviewStatus: z.literal("approved"), securityStatus: z.literal("passed"),
  platforms: z.array(platformSchema).max(100),
  artifact: z.object({ sha256: sha256Schema, byteSize: z.number().int().positive().max(NATIVE_API_BUNDLE_BYTES), contentType: z.literal("application/vnd.myskills-app.package+json") }),
});
const pageSchema = z.object({
  skills: z.array(z.object({ slug: skillSlugSchema, latestVersion: z.string().nullable(), lifecycleStatus: z.string(), reviewStatus: z.string(), securityStatus: z.string() })).max(NATIVE_SKILL_PAGE_SIZE),
  nextCursor: z.string().max(1024).nullable().optional(),
});
const bundleSchema = z.object({ files: z.array(z.object({ path: z.string().min(1).max(1024), content: z.string() }).strict()).min(1).max(MAX_PACKAGE_FILES) }).strict();

export interface NativeSkill {
  uri: string;
  frontmatter: { name: string; description: string; [key: string]: unknown };
  resources: Array<{ uri: string; digest: string; size: number }>;
}

type NativeClient = ReturnType<typeof createNativeRegistryApiClient>;
class IncompatibleSkill extends Error {}
interface SkillIdentity { slug: string; version: string; digest: string; name: string; path: string }

export function createNativeSkillsHandlers(options: RegistryApiClientOptions) {
  const origin = digest(createRegistryApiClient(options).baseUrl);

  function operation<T>(method: NativeMcpMethod, signal: AbortSignal | undefined, run: (client: NativeClient) => Promise<T>) {
    return safe(async () => {
      const boundedSignal = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
      const client = createNativeRegistryApiClient(options, boundedSignal);
      const session = await client.authenticate(method);
      if (session.credential?.kind !== "api_token" || !session.credential.scopes.includes("skills:read")) {
        throw new RegistryApiError(403);
      }
      return run(client);
    });
  }

  async function load(client: NativeClient, slug: string, version: string) {
    const prefix = `/v1/skills/${encodeURIComponent(slug)}/releases/${encodeURIComponent(version)}`;
    const body = await client.json<unknown>(prefix);
    const projection = z.object({ release: releaseSchema }).safeParse(body);
    if (!projection.success) throw new IncompatibleSkill();
    const release = projection.data.release;
    if (release.slug !== slug || release.version !== version) throw new IncompatibleSkill();
    const platform = release.platforms.filter((item) => item.status === "supported")
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)[0];
    if (!platform) throw new IncompatibleSkill();
    const bytes = await client.bytes(`${prefix}/bundle?platform=${encodeURIComponent(platform.name)}`, release.artifact.byteSize);
    if (bytes.byteLength !== release.artifact.byteSize || digest(bytes) !== release.artifact.sha256) throw new IncompatibleSkill();
    let files: z.infer<typeof bundleSchema>["files"];
    let frontmatter: NativeSkill["frontmatter"];
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      files = bundleSchema.parse(JSON.parse(text)).files;
      for (const file of files) {
        if (normalizePackageFilePath(file.path) !== file.path) throw new Error();
      }
      validatePortableFilePaths(files);
      // Reuse the package reader's UTF-8, collision, count and byte checks. New
      // scanner findings do not override the API's reviewed artifact decision.
      const scan = scanPackageFiles(files);
      if (scan.bytesScanned > MAX_PACKAGE_TEXT_BYTES || scan.filesScanned !== files.length) throw new Error();
      const manifest = loadStoredSkillManifestFromPackageFiles(files);
      if (manifest.name !== slug || manifest.version !== version || !manifest.platforms.some((item) =>
        item.name === platform.name && item.status === "supported" && item.install_target === platform.installTarget)) throw new Error();
      const instructions = files.find((file) => file.path === "SKILL.md");
      if (!instructions) throw new Error();
      frontmatter = readFrontmatter(instructions.content);
    } catch {
      throw new IncompatibleSkill();
    }
    const identity = { slug, version, digest: release.artifact.sha256, name: frontmatter.name };
    const skill: NativeSkill = {
      uri: resourceUri(origin, { ...identity, path: "SKILL.md" }),
      frontmatter,
      resources: files.map((file) => ({
        uri: resourceUri(origin, { ...identity, path: file.path }),
        digest: `sha256:${digest(file.content)}`,
        size: Buffer.byteLength(file.content, "utf8"),
      })).sort((a, b) => a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0),
    };
    return { skill, files };
  }

  async function loadUri(client: NativeClient, uri: string, instructionsOnly: boolean) {
    const identity = parseResourceUri(origin, uri);
    if (instructionsOnly && identity.path !== "SKILL.md") throw new IncompatibleSkill();
    const loaded = await load(client, identity.slug, identity.version);
    if (loaded.skill.uri !== resourceUri(origin, { ...identity, path: "SKILL.md" })) throw new IncompatibleSkill();
    return { ...loaded, identity };
  }

  return {
    list(input: { cursor?: string } = {}, signal?: AbortSignal) {
      return operation("skills/list", signal, async (client) => {
        const cursor = decodeCursor(origin, input.cursor);
        const query = new URLSearchParams({ limit: String(NATIVE_SKILL_PAGE_SIZE) });
        if (cursor) query.set("cursor", cursor);
        const page = pageSchema.parse(await client.json(`/v1/skills?${query}`));
        const skills: NativeSkill[] = [];
        for (const entry of page.skills) {
          if (entry.lifecycleStatus !== "approved" || entry.reviewStatus !== "approved" || entry.securityStatus !== "passed" || !versionSchema.safeParse(entry.latestVersion).success || !entry.latestVersion || entry.latestVersion.split("+", 1)[0].includes("-")) continue;
          try {
            skills.push((await load(client, entry.slug, entry.latestVersion)).skill);
          } catch (error) {
            // Missing/revoked candidates can disappear between the page and its
            // artifact reads. Auth and upstream failures must not become an empty catalog.
            if (!(error instanceof IncompatibleSkill) && !(error instanceof RegistryApiError && error.status === 404)) throw error;
          }
        }
        return {
          ...privateResult, skills,
          ...(page.nextCursor ? { nextCursor: encodeCursor(origin, page.nextCursor) } : {}),
        };
      });
    },
    get(input: { uri: string }, signal?: AbortSignal) {
      return operation("skills/get", signal, async (client) => {
        const { skill } = await loadUri(client, input.uri, true);
        return { ...privateResult, skill };
      });
    },
    read(input: { uri: string }, signal?: AbortSignal) {
      return operation("resources/read", signal, async (client) => {
        const { files, identity } = await loadUri(client, input.uri, false);
        const file = files.find((item) => item.path === identity.path);
        if (!file) throw new IncompatibleSkill();
        return { ...privateResult, contents: [{ uri: input.uri, mimeType: file.path.endsWith(".md") ? "text/markdown" : "text/plain", text: file.content }] };
      });
    },
  };
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function resourceUri(origin: string, identity: SkillIdentity): string {
  const uri = `skill://myskills-${origin}/${[identity.slug, identity.version, identity.digest, identity.name, ...identity.path.split("/")].map(encodeURIComponent).join("/")}`;
  if (uri.length > NATIVE_RESOURCE_URI_CHARS) throw new IncompatibleSkill();
  return uri;
}

function parseResourceUri(origin: string, uri: string): SkillIdentity {
  const prefix = `skill://myskills-${origin}/`;
  if (typeof uri !== "string" || uri.length > NATIVE_RESOURCE_URI_CHARS || !uri.startsWith(prefix)) throw new IncompatibleSkill();
  const parts = uri.slice(prefix.length).split("/").map((part) => decodeURIComponent(part));
  if (parts.length < 5) throw new IncompatibleSkill();
  const [slug, version, artifact, name, ...path] = parts;
  const identity = { slug: skillSlugSchema.parse(slug), version: versionSchema.parse(version), digest: sha256Schema.parse(artifact), name: skillSlugSchema.parse(name), path: path.join("/") };
  if (normalizePackageFilePath(identity.path) !== identity.path || resourceUri(origin, identity) !== uri) throw new IncompatibleSkill();
  return identity;
}

function encodeCursor(origin: string, cursor: string): string {
  return Buffer.from(JSON.stringify({ v: 1, origin, cursor })).toString("base64url");
}

function decodeCursor(origin: string, cursor?: string): string | undefined {
  if (cursor === undefined) return undefined;
  if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new IncompatibleSkill();
  const value = z.object({ v: z.literal(1), origin: z.literal(origin), cursor: z.string().min(1).max(1024) }).strict().parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  if (encodeCursor(origin, value.cursor) !== cursor) throw new IncompatibleSkill();
  return value.cursor;
}

function readFrontmatter(content: string): NativeSkill["frontmatter"] {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match || Buffer.byteLength(match[1]) > 32 * 1024) throw new IncompatibleSkill();
  const document = parseDocument(match[1], { strict: true, uniqueKeys: true, schema: "core" });
  if (document.errors.length || document.warnings.length) throw new IncompatibleSkill();
  visit(document, {
    Alias() { throw new IncompatibleSkill(); },
    Pair(_key, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") throw new IncompatibleSkill();
    },
  });
  const parsed: unknown = document.toJS({ maxAliasCount: 0 });
  let nodes = 0;
  const check = (value: unknown, depth: number): void => {
    if (++nodes > 4096 || depth > 20) throw new IncompatibleSkill();
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (Array.isArray(value)) { for (const item of value) check(item, depth + 1); return; }
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      for (const item of Object.values(value)) check(item, depth + 1);
      return;
    }
    throw new IncompatibleSkill();
  };
  check(parsed, 0);
  // Validate the required fields without rebuilding the mapping: every authored
  // field, including unusual JSON property names, must remain identical.
  z.object({
    name: skillSlugSchema,
    description: z.string().min(1).max(1024).refine((value) => value.trim().length > 0),
    license: z.string().optional(),
    compatibility: z.string().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    "allowed-tools": z.string().optional(),
  }).parse(parsed);
  return parsed as NativeSkill["frontmatter"];
}

async function safe<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof RegistryApiError && error.status >= 500) throw new ProtocolError(-32603, "Skill delivery is temporarily unavailable.");
    // No URI, upstream parser excerpt, token, body or existence distinction.
    throw new ProtocolError(-32602, "Skill or resource is unavailable for this request.");
  }
}
