import { createHash } from "node:crypto";
import { AppError, compareSemanticVersions, parseSemanticVersion, type LibrarySourceRef } from "@myskills-app/core";

/**
 * Public GitHub read adapter. It talks only to two fixed hosts, never sends
 * credentials, never follows redirects and bounds every body and request.
 * Tests inject a deterministic transport through the constructor; production
 * wiring in server.ts always uses the fetch transport.
 */

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_RAW_ORIGIN = "https://raw.githubusercontent.com";
const ALLOWED_HOSTS = new Set(["api.github.com", "raw.githubusercontent.com"]);
const KEPT_RESPONSE_HEADERS = ["content-type", "etag", "retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"] as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const JSON_BODY_LIMIT = 1024 * 1024;
const TREE_BODY_LIMIT = 16 * 1024 * 1024;
const COMPARE_BODY_LIMIT = 4 * 1024 * 1024;
const MATCHING_REFS_BODY_LIMIT = 2 * 1024 * 1024;
export const MAX_SOURCE_INVENTORY_PATHS = 10_000;

export interface SourceHttpRequest {
  url: URL;
  headers: Record<string, string>;
  signal: AbortSignal;
  maxBytes: number;
}

export interface SourceHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface SourceHttpTransport {
  get(request: SourceHttpRequest): Promise<SourceHttpResponse>;
}

export interface SourceRequestContext {
  /** Epoch milliseconds (wall clock) after which no further provider request starts. */
  deadline: number;
}

export interface GithubRepositoryInfo {
  id: string;
  fullName: string;
  owner: string;
  name: string;
  htmlUrl: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  licenseSpdx: string | null;
}

export interface ResolvedSourceRef {
  commitSha: string;
  treeSha: string;
  resolvedRef: string | null;
  upstreamLabel: string | null;
  releaseId: string | null;
}

export interface SourceTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "commit";
  sha: string;
  size: number | null;
}

export interface SourceTree {
  entries: SourceTreeEntry[];
  truncated: boolean;
}

export type SourceCommitOrder = "ahead" | "identical" | "behind" | "diverged" | "unknown";

export interface UpstreamSourceProvider {
  getRepositoryByName(owner: string, repo: string, context: SourceRequestContext): Promise<GithubRepositoryInfo>;
  getRepositoryById(id: string, context: SourceRequestContext): Promise<GithubRepositoryInfo>;
  resolveRef(repository: GithubRepositoryInfo, ref: LibrarySourceRef, context: SourceRequestContext): Promise<ResolvedSourceRef>;
  getTree(repository: GithubRepositoryInfo, treeSha: string, context: SourceRequestContext): Promise<SourceTree>;
  /** Returns exact bytes only when they hash to the expected Git blob SHA. */
  readBlob(repository: GithubRepositoryInfo, commitSha: string, path: string, expectedBlobSha: string, maxBytes: number, context: SourceRequestContext): Promise<Uint8Array>;
  compareCommits(repository: GithubRepositoryInfo, base: string, head: string, context: SourceRequestContext): Promise<SourceCommitOrder>;
}

export function sourceError(code: string, message: string, status: number, details?: Record<string, unknown>): AppError {
  return new AppError(message, code, status, details);
}

export function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

export function createFetchSourceTransport(): SourceHttpTransport {
  return {
    async get(request) {
      const response = await fetch(request.url, {
        method: "GET",
        headers: request.headers,
        redirect: "manual",
        signal: request.signal,
      });
      const headers: Record<string, string> = {};
      for (const name of KEPT_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      // Never read or expose a redirect target.
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return { status: response.status, headers, body: new Uint8Array() };
      }
      const declared = Number(response.headers.get("content-length") ?? Number.NaN);
      if (Number.isFinite(declared) && declared > request.maxBytes) {
        await response.body?.cancel();
        throw sourceError("SOURCE_RESPONSE_TOO_LARGE", "The source response exceeds the allowed size.", 422);
      }
      if (!response.body) return { status: response.status, headers, body: new Uint8Array() };
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > request.maxBytes) {
          await reader.cancel();
          throw sourceError("SOURCE_RESPONSE_TOO_LARGE", "The source response exceeds the allowed size.", 422);
        }
        chunks.push(value);
      }
      return { status: response.status, headers, body: Buffer.concat(chunks) };
    },
  };
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REF_NAME_PATTERN = /^[A-Za-z0-9._/-]{1,255}$/;

export class PublicGithubSourceProvider implements UpstreamSourceProvider {
  private readonly transport: SourceHttpTransport;
  private readonly requestTimeoutMs: number;

  constructor(options: { transport?: SourceHttpTransport; requestTimeoutMs?: number } = {}) {
    this.transport = options.transport ?? createFetchSourceTransport();
    this.requestTimeoutMs = Math.min(Math.max(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 1_000), 30_000);
  }

  async getRepositoryByName(owner: string, repo: string, context: SourceRequestContext): Promise<GithubRepositoryInfo> {
    if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo) || repo === "." || repo === "..") {
      throw sourceError("SOURCE_URL_UNSUPPORTED", "Repository owner or name is invalid.", 400);
    }
    return repositoryInfo(await this.json(apiUrl(["repos", owner, repo]), context, JSON_BODY_LIMIT));
  }

  async getRepositoryById(id: string, context: SourceRequestContext): Promise<GithubRepositoryInfo> {
    if (!/^[1-9][0-9]{0,19}$/.test(id)) throw sourceError("SOURCE_UNAVAILABLE", "Source repository is unavailable.", 404);
    const info = repositoryInfo(await this.json(apiUrl(["repositories", id]), context, JSON_BODY_LIMIT));
    if (info.id !== id) throw sourceError("SOURCE_IDENTITY_CHANGED", "The provider returned a different repository.", 409);
    return info;
  }

  async resolveRef(repository: GithubRepositoryInfo, ref: LibrarySourceRef, context: SourceRequestContext): Promise<ResolvedSourceRef> {
    let commitSha: string;
    let resolvedRef: string | null = null;
    let upstreamLabel: string | null = null;
    let releaseId: string | null = null;
    switch (ref.kind) {
      case "default-branch":
      case "branch": {
        const branch = ref.kind === "default-branch" ? repository.defaultBranch : requireRefName(ref.value);
        commitSha = await this.refCommit(repository, "heads", branch, context);
        resolvedRef = `refs/heads/${branch}`;
        break;
      }
      case "tag": {
        const tag = requireRefName(ref.value);
        commitSha = await this.refCommit(repository, "tags", tag, context);
        resolvedRef = `refs/tags/${tag}`;
        upstreamLabel = tag;
        break;
      }
      case "commit": {
        if (!ref.value || !SHA_PATTERN.test(ref.value)) throw sourceError("SOURCE_REF_INVALID", "Commit refs must be 40-character lowercase SHAs.", 400);
        commitSha = ref.value;
        break;
      }
      case "latest-release": {
        const release = record(await this.json(repoUrl(repository, ["releases", "latest"]), context, JSON_BODY_LIMIT));
        const tag = typeof release.tag_name === "string" ? release.tag_name : "";
        if (!REF_NAME_PATTERN.test(tag) || tag.includes("..")) throw sourceError("SOURCE_REF_NOT_FOUND", "The latest release has no usable tag.", 404);
        commitSha = await this.refCommit(repository, "tags", tag, context);
        resolvedRef = `refs/tags/${tag}`;
        upstreamLabel = tag;
        releaseId = typeof release.id === "number" || typeof release.id === "string" ? String(release.id) : null;
        break;
      }
      case "tag-prefix": {
        const prefix = requireRefName(ref.value);
        const refs = await this.json(repoUrl(repository, ["git", "matching-refs", "tags", ...prefix.split("/")]), context, MATCHING_REFS_BODY_LIMIT);
        if (!Array.isArray(refs)) throw providerUnavailable();
        let best: { tag: string; version: string } | null = null;
        for (const item of refs.slice(0, 1_000)) {
          const name = typeof record(item).ref === "string" ? String(record(item).ref) : "";
          if (!name.startsWith(`refs/tags/${prefix}`)) continue;
          const tag = name.slice("refs/tags/".length);
          const version = tag.slice(prefix.length).replace(/^v/, "");
          if (!parseSemanticVersion(version) || parseSemanticVersion(version)!.prerelease.length > 0) continue;
          if (!best || compareSemanticVersions(version, best.version) > 0) best = { tag, version };
        }
        if (!best) throw sourceError("SOURCE_REF_NOT_FOUND", "No stable SemVer tag matches this prefix.", 404);
        commitSha = await this.refCommit(repository, "tags", best.tag, context);
        resolvedRef = `refs/tags/${best.tag}`;
        upstreamLabel = best.tag;
        break;
      }
      default:
        throw sourceError("SOURCE_REF_INVALID", "Unsupported ref rule.", 400);
    }
    const commit = record(await this.json(repoUrl(repository, ["git", "commits", commitSha]), context, JSON_BODY_LIMIT));
    const treeSha = typeof record(commit.tree).sha === "string" ? String(record(commit.tree).sha) : "";
    if (commit.sha !== commitSha || !SHA_PATTERN.test(treeSha)) throw providerUnavailable();
    return { commitSha, treeSha, resolvedRef, upstreamLabel, releaseId };
  }

  async getTree(repository: GithubRepositoryInfo, treeSha: string, context: SourceRequestContext): Promise<SourceTree> {
    if (!SHA_PATTERN.test(treeSha)) throw providerUnavailable();
    const url = repoUrl(repository, ["git", "trees", treeSha]);
    url.searchParams.set("recursive", "1");
    let body: unknown;
    try {
      body = await this.json(url, context, TREE_BODY_LIMIT);
    } catch (error) {
      if (error instanceof AppError && error.code === "SOURCE_RESPONSE_TOO_LARGE") return { entries: [], truncated: true };
      throw error;
    }
    const tree = record(body);
    if (!Array.isArray(tree.tree)) throw providerUnavailable();
    const entries: SourceTreeEntry[] = [];
    let truncated = tree.truncated === true;
    for (const item of tree.tree) {
      const entry = record(item);
      if (entry.type !== "blob" && entry.type !== "commit") continue;
      if (typeof entry.path !== "string" || typeof entry.mode !== "string" || typeof entry.sha !== "string" || !SHA_PATTERN.test(entry.sha)) {
        throw providerUnavailable();
      }
      if (entries.length >= MAX_SOURCE_INVENTORY_PATHS) {
        truncated = true;
        break;
      }
      entries.push({
        path: entry.path,
        mode: entry.mode,
        type: entry.type,
        sha: entry.sha,
        size: typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : null,
      });
    }
    return { entries, truncated };
  }

  async readBlob(
    repository: GithubRepositoryInfo,
    commitSha: string,
    path: string,
    expectedBlobSha: string,
    maxBytes: number,
    context: SourceRequestContext,
  ): Promise<Uint8Array> {
    if (!SHA_PATTERN.test(commitSha) || !SHA_PATTERN.test(expectedBlobSha)) throw providerUnavailable();
    const segments = path.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw providerUnavailable();
    const url = new URL(`${GITHUB_RAW_ORIGIN}/${[repository.owner, repository.name, commitSha, ...segments].map(encodeURIComponent).join("/")}`);
    const response = await this.request(url, context, maxBytes, "application/octet-stream");
    if (gitBlobSha(response.body) !== expectedBlobSha) {
      throw sourceError("SOURCE_INTEGRITY_MISMATCH", "Fetched source bytes do not match the snapshot inventory.", 503);
    }
    return response.body;
  }

  async compareCommits(repository: GithubRepositoryInfo, base: string, head: string, context: SourceRequestContext): Promise<SourceCommitOrder> {
    if (!SHA_PATTERN.test(base) || !SHA_PATTERN.test(head)) return "unknown";
    if (base === head) return "identical";
    try {
      const url = repoUrl(repository, ["compare", `${base}...${head}`]);
      url.searchParams.set("per_page", "1");
      const status = record(await this.json(url, context, COMPARE_BODY_LIMIT)).status;
      return status === "ahead" || status === "identical" || status === "behind" || status === "diverged" ? status : "unknown";
    } catch (error) {
      if (error instanceof AppError && error.code === "SOURCE_RATE_LIMITED") throw error;
      return "unknown";
    }
  }

  private async refCommit(repository: GithubRepositoryInfo, namespace: "heads" | "tags", name: string, context: SourceRequestContext): Promise<string> {
    let object: Record<string, unknown>;
    try {
      object = record(record(await this.json(repoUrl(repository, ["git", "ref", namespace, ...name.split("/")]), context, JSON_BODY_LIMIT)).object);
    } catch (error) {
      if (error instanceof AppError && error.code === "SOURCE_UNAVAILABLE") {
        throw sourceError("SOURCE_REF_NOT_FOUND", "The requested ref does not exist in the source repository.", 404);
      }
      throw error;
    }
    if (object.type === "commit" && typeof object.sha === "string" && SHA_PATTERN.test(object.sha)) return object.sha;
    if (object.type === "tag" && typeof object.sha === "string" && SHA_PATTERN.test(object.sha)) {
      // One annotated-tag hop only; nested tag objects are not followed.
      const tag = record(record(await this.json(repoUrl(repository, ["git", "tags", object.sha]), context, JSON_BODY_LIMIT)).object);
      if (tag.type === "commit" && typeof tag.sha === "string" && SHA_PATTERN.test(tag.sha)) return tag.sha;
    }
    throw sourceError("SOURCE_REF_NOT_FOUND", "The requested ref does not resolve to a commit.", 404);
  }

  private async json(url: URL, context: SourceRequestContext, maxBytes: number): Promise<unknown> {
    const response = await this.request(url, context, maxBytes, "application/vnd.github+json");
    try {
      return JSON.parse(Buffer.from(response.body).toString("utf8"));
    } catch {
      throw providerUnavailable();
    }
  }

  private async request(url: URL, context: SourceRequestContext, maxBytes: number, accept: string): Promise<SourceHttpResponse> {
    if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.host) || url.username || url.password || url.port) {
      throw sourceError("SOURCE_URL_UNSUPPORTED", "Source requests are limited to fixed GitHub hosts.", 400);
    }
    const remaining = context.deadline - Date.now();
    if (remaining <= 0) throw sourceError("SOURCE_TIMEOUT", "The source check exceeded its time limit.", 503);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.requestTimeoutMs, remaining));
    let response: SourceHttpResponse;
    try {
      response = await this.transport.get({
        url,
        headers: {
          accept,
          "user-agent": "myskills-library-importer",
          "x-github-api-version": "2022-11-28",
        },
        signal: controller.signal,
        maxBytes,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (controller.signal.aborted) throw sourceError("SOURCE_TIMEOUT", "The source request timed out.", 503);
      throw providerUnavailable();
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      // Do not follow or disclose redirect targets.
      throw sourceError("SOURCE_REDIRECT_REJECTED", "The source answered with a redirect. Save the repository by its current URL.", 409);
    }
    if (response.status === 403 || response.status === 429) {
      const reset = Number(response.headers["x-ratelimit-reset"]);
      const retryAfter = Number(response.headers["retry-after"]);
      const limited = response.status === 429 || response.headers["x-ratelimit-remaining"] === "0" || Number.isFinite(retryAfter);
      if (limited) {
        throw sourceError("SOURCE_RATE_LIMITED", "The source provider rate limit was reached.", 429, {
          ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterSeconds: Math.min(Math.ceil(retryAfter), 86_400) } : {}),
          ...(Number.isFinite(reset) && reset > 0 ? { rateLimitResetEpochSeconds: Math.floor(reset) } : {}),
        });
      }
      throw sourceError("SOURCE_ACCESS_LOST", "The public source is no longer readable without credentials.", 403);
    }
    if (response.status === 404 || response.status === 410 || response.status === 451) {
      throw sourceError("SOURCE_UNAVAILABLE", "Source repository or path is unavailable.", 404);
    }
    if (response.status !== 200) throw providerUnavailable();
    return response;
  }
}

function apiUrl(segments: string[]): URL {
  return new URL(`${GITHUB_API_ORIGIN}/${segments.map(encodeURIComponent).join("/")}`);
}

function repoUrl(repository: GithubRepositoryInfo, segments: string[]): URL {
  return apiUrl(["repos", repository.owner, repository.name, ...segments]);
}

function requireRefName(value: string | undefined): string {
  if (!value || !REF_NAME_PATTERN.test(value) || value.includes("..") || value.startsWith("/") || value.startsWith("-") || value.endsWith("/")) {
    throw sourceError("SOURCE_REF_INVALID", "The ref name is invalid.", 400);
  }
  return value;
}

function repositoryInfo(input: unknown): GithubRepositoryInfo {
  const repo = record(input);
  const fullName = typeof repo.full_name === "string" ? repo.full_name : "";
  const [owner, name, extra] = fullName.split("/");
  const id = typeof repo.id === "number" && Number.isSafeInteger(repo.id) && repo.id > 0 ? String(repo.id) : "";
  if (!id || !owner || !name || extra !== undefined || !OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(name)) throw providerUnavailable();
  const defaultBranch = typeof repo.default_branch === "string" && REF_NAME_PATTERN.test(repo.default_branch) ? repo.default_branch : "";
  if (!defaultBranch) throw providerUnavailable();
  const license = record(repo.license).spdx_id;
  if (repo.private === true || (typeof repo.visibility === "string" && repo.visibility !== "public")) {
    throw sourceError("SOURCE_ACCESS_LOST", "Only public repositories are supported in this release.", 403);
  }
  return {
    id,
    fullName: `${owner}/${name}`,
    owner,
    name,
    htmlUrl: `https://github.com/${owner}/${name}`,
    defaultBranch,
    private: false,
    archived: repo.archived === true,
    licenseSpdx: typeof license === "string" && /^[A-Za-z0-9.+-]{1,80}$/.test(license) && license !== "NOASSERTION" ? license : null,
  };
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function providerUnavailable(): AppError {
  return sourceError("SOURCE_PROVIDER_UNAVAILABLE", "The source provider returned an unusable response.", 503);
}
